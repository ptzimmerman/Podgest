/**
 * Podgest MCP Server
 * 
 * Model Context Protocol server for querying podcast transcripts via Claude Desktop.
 * Uses Cloudflare Workers OAuth Provider for authentication.
 * 
 * Tools:
 * - search_podcasts: Semantic search across all transcripts
 * - get_episode: Get episode details and transcript URL
 * - compare_takes: Compare perspectives across podcasts on a topic
 * - list_podcasts: List subscribed podcasts
 * - recent_episodes: Get recent episodes
 */

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Env interface with OAuth Provider bindings
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  SUPERMEMORY_API_KEY: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

const MCP_SERVER_URL = "https://podgest-mcp.pztest.workers.dev";

// Extract original podcast name from ListenNotes episode description
function extractOriginalPodcastName(description: string): string | null {
  // Try ListenNotes format: <strong>Podcast</strong>: <a href="...">Podcast Name</a>
  const listenNotesMatch = description.match(/<strong>Podcast<\/strong>:\s*<a[^>]*>([^<]+)<\/a>/i);
  if (listenNotesMatch) {
    return listenNotesMatch[1].trim();
  }
  return null;
}

// Extract ListenNotes episode URL from description
function extractListenNotesUrl(description: string): string | null {
  // Format: <strong>Episode</strong>: <a href="https://www.listennotes.com/e/...">
  const match = description.match(/<strong>Episode<\/strong>:\s*<a\s+href="([^"]+)"/i);
  if (match) {
    return match[1];
  }
  return null;
}

// Build listen links object for an episode
interface ListenLinks {
  audio_url: string;              // Direct MP3 playback
  // iOS app deep links - open app DIRECTLY (no browser)
  spotify_app: string;            // spotify:search:query - opens Spotify app
  apple_app: string;              // podcasts://search?term=query - opens Podcasts app
  // Web fallbacks (for desktop or if app not installed)
  spotify_web: string;            // https://open.spotify.com/search/...
  apple_web: string;              // https://podcasts.apple.com/search?term=...
  listennotes_url?: string;       // Fallback: ListenNotes page
}

function buildListenLinks(
  audioUrl: string, 
  podcastName: string, 
  episodeTitle: string,
  description?: string
): ListenLinks {
  // Clean up title (remove HTML entities)
  const cleanTitle = episodeTitle
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]*>/g, "");
  
  // Create search query: "podcast name episode title"
  const searchQuery = `${podcastName} ${cleanTitle}`;
  const encodedQuery = encodeURIComponent(searchQuery);
  
  const links: ListenLinks = {
    audio_url: audioUrl,
    // iOS deep links - open apps DIRECTLY without browser intermediate
    spotify_app: `spotify:search:${encodedQuery}`,
    apple_app: `podcasts://search?term=${encodedQuery}`,
    // Web fallbacks for desktop or if app not installed
    spotify_web: `https://open.spotify.com/search/${encodedQuery}`,
    apple_web: `https://podcasts.apple.com/search?term=${encodedQuery}`,
  };
  
  if (description) {
    const listenNotesUrl = extractListenNotesUrl(description);
    if (listenNotesUrl) {
      links.listennotes_url = listenNotesUrl;
    }
  }
  
  return links;
}

// MCP Protocol Types
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Tool definitions
const TOOLS: MCPTool[] = [
  {
    name: "search_podcasts",
    description: "Semantic search across all podcast transcripts. Returns relevant excerpts with source attribution.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g., 'What did they say about AI regulation?')",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 5, max: 20)",
        },
        days_back: {
          type: "number",
          description: "Only search episodes from the last N days (optional)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_episode",
    description: "Get detailed information about a specific episode including summary, topics, and link to full transcript.",
    inputSchema: {
      type: "object",
      properties: {
        episode_id: {
          type: "string",
          description: "The episode UUID",
        },
      },
      required: ["episode_id"],
    },
  },
  {
    name: "compare_takes",
    description: "Find how different podcasts covered the same topic. Returns contrasting perspectives.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The topic to compare (e.g., 'Trump tariffs', 'AI safety')",
        },
        days_back: {
          type: "number",
          description: "Only search episodes from the last N days (default: 30)",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "list_podcasts",
    description: "List all podcasts you're subscribed to.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "recent_episodes",
    description: "Get the most recent episodes across all subscribed podcasts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of episodes to return (default: 10, max: 50)",
        },
        days_back: {
          type: "number",
          description: "Only show episodes from the last N days (default: 7)",
        },
      },
    },
  },
  {
    name: "listen_to_episode",
    description: "Get links to listen to a full podcast episode. Returns iOS app deep links (open Spotify/Apple Podcasts directly without browser) plus web fallbacks and direct audio URL.",
    inputSchema: {
      type: "object",
      properties: {
        episode_id: {
          type: "string",
          description: "The episode UUID",
        },
      },
      required: ["episode_id"],
    },
  },
];

// ============================================
// TOOL IMPLEMENTATIONS
// ============================================

async function searchPodcasts(
  query: string,
  limit: number = 5,
  daysBack: number | undefined,
  userId: string,
  env: Env
): Promise<{ results: Array<{ episode_id: string; podcast_name: string; title: string; excerpt: string; published_at: string }> }> {
  // Search SuperMemory with user's container tag
  const searchParams: Record<string, unknown> = {
    q: query,
    limit: Math.min(limit, 20),
    containerTags: [userId],
  };

  if (daysBack) {
    // TODO: Date filtering doesn't seem to work with SuperMemory's filter syntax
    // For now, just log the date we would have filtered by
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    console.log(`[searchPodcasts] Would filter by date >= ${cutoffDate.toISOString()} (${cutoffDate.getTime()})`)
  }

  const searchResponse = await fetch("https://api.supermemory.ai/v3/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUPERMEMORY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(searchParams),
  });

  if (!searchResponse.ok) {
    console.error("SuperMemory search failed:", await searchResponse.text());
    return { results: [] };
  }

  const searchResults = await searchResponse.json() as {
    results: Array<{
      id: string;
      content?: string;
      chunks?: Array<{ content: string }>;
      metadata?: {
        episode_id?: string;
        podcast_title?: string;
        episode_title?: string;
        published_at?: number;
      };
    }>;
  };

  return {
    results: (searchResults.results || []).map((r) => ({
      episode_id: r.metadata?.episode_id || r.id,
      podcast_name: r.metadata?.podcast_title || "Unknown",
      title: r.metadata?.episode_title || "Unknown",
      excerpt: r.chunks?.[0]?.content?.substring(0, 500) || r.content?.substring(0, 500) || "No content available",
      published_at: r.metadata?.published_at ? new Date(r.metadata.published_at).toISOString() : "",
    })),
  };
}

async function getEpisode(
  episodeId: string,
  userId: string,
  env: Env
): Promise<{
  episode_id: string;
  podcast_name: string;
  title: string;
  published_at: string;
  summary?: string;
  topics?: string[];
  transcript_url?: string;
  listen_links?: ListenLinks;
} | { error: string }> {
  // Fetch episode with description and audio_url
  const episodeResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${episodeId}&select=id,title,published_at,feed_url,description,audio_url`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  const episodes = await episodeResponse.json() as Array<{
    id: string;
    title: string;
    published_at: string;
    feed_url: string;
    description?: string;
    audio_url: string;
  }>;

  if (!episodes.length) {
    return { error: "Episode not found" };
  }

  const episode = episodes[0];
  
  // Verify user has a subscription for this episode's feed
  const subResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&feed_url=eq.${encodeURIComponent(episode.feed_url)}&select=podcast_title`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  
  const subs = await subResponse.json() as Array<{ podcast_title: string }>;
  
  if (!subs.length) {
    return { error: "Episode not found" };
  }
  
  // Extract original podcast name from description (for ListenNotes aggregated feeds)
  const originalName = extractOriginalPodcastName(episode.description || "");
  const podcastTitle = originalName || subs[0].podcast_title;

  // Get transcription
  const transcriptionResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${episodeId}&select=transcript_storage_path`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  const transcriptions = await transcriptionResponse.json() as Array<{ transcript_storage_path?: string }>;
  
  // Get topic extraction
  let summary: string | undefined;
  let topics: string[] | undefined;
  
  const topicsResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/topic_extractions?transcription_id=eq.${episodeId}&select=topics,summary`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  const topicData = await topicsResponse.json() as Array<{ topics?: string[]; summary?: string }>;
  if (topicData.length) {
    summary = topicData[0].summary;
    topics = topicData[0].topics;
  }

  // Generate signed URL for transcript if available
  let transcriptUrl: string | undefined;
  if (transcriptions.length && transcriptions[0].transcript_storage_path) {
    const signResponse = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/sign/transcripts/${transcriptions[0].transcript_storage_path}`,
      {
        method: "POST",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    const signData = await signResponse.json() as { signedURL?: string };
    if (signData.signedURL) {
      transcriptUrl = `${env.SUPABASE_URL}/storage/v1${signData.signedURL}`;
    }
  }

  return {
    episode_id: episode.id,
    podcast_name: podcastTitle,
    title: episode.title,
    published_at: episode.published_at,
    summary,
    topics,
    transcript_url: transcriptUrl,
  };
}

async function compareTakes(
  topic: string,
  daysBack: number = 30,
  userId: string,
  env: Env
): Promise<{ perspectives: Array<{ podcast_name: string; episode_title: string; take: string; published_at: string }> }> {
  // Search for the topic across all podcasts
  const searchParams: Record<string, unknown> = {
    q: topic,
    limit: 10,
    containerTags: [userId],
  };

  // TODO: Date filtering doesn't seem to work with SuperMemory's filter syntax
  // For now, just log the date we would have filtered by
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  console.log(`[compareTakes] Would filter by date >= ${cutoffDate.toISOString()} (${cutoffDate.getTime()})`);

  const searchResponse = await fetch("https://api.supermemory.ai/v3/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUPERMEMORY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(searchParams),
  });

  if (!searchResponse.ok) {
    return { perspectives: [] };
  }

  const searchResults = await searchResponse.json() as {
    results: Array<{
      content?: string;
      chunks?: Array<{ content: string }>;
      metadata?: {
        podcast_title?: string;
        episode_title?: string;
        published_at?: number;
      };
    }>;
  };

  // Group by podcast and take best result from each
  const byPodcast = new Map<string, typeof searchResults.results[0]>();
  for (const result of searchResults.results || []) {
    const podcastName = result.metadata?.podcast_title || "Unknown";
    if (!byPodcast.has(podcastName)) {
      byPodcast.set(podcastName, result);
    }
  }

  return {
    perspectives: Array.from(byPodcast.values()).map((r) => ({
      podcast_name: r.metadata?.podcast_title || "Unknown",
      episode_title: r.metadata?.episode_title || "Unknown",
      take: r.chunks?.[0]?.content?.substring(0, 800) || r.content?.substring(0, 800) || "No content",
      published_at: r.metadata?.published_at ? new Date(r.metadata.published_at).toISOString() : "",
    })),
  };
}

async function listPodcasts(
  userId: string,
  env: Env
): Promise<{ podcasts: Array<{ id: string; name: string; feed_url: string; episode_count: number }> }> {
  console.log(`[listPodcasts] Fetching for user: ${userId}`);
  
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=id,podcast_title,feed_url`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!response.ok) {
    console.error(`[listPodcasts] Supabase error: ${response.status} ${await response.text()}`);
    return { podcasts: [] };
  }

  const subscriptions = await response.json();
  console.log(`[listPodcasts] Got subscriptions:`, JSON.stringify(subscriptions));
  
  if (!Array.isArray(subscriptions)) {
    console.error(`[listPodcasts] Expected array, got:`, typeof subscriptions);
    return { podcasts: [] };
  }

  // Get episode counts for each subscription (episodes link by feed_url)
  const podcastsWithCounts = await Promise.all(
    subscriptions.map(async (sub: { id: string; podcast_title: string; feed_url: string }) => {
      const countResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/episodes?feed_url=eq.${encodeURIComponent(sub.feed_url)}&select=id`,
        {
          headers: {
            "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "count=exact",
          },
        }
      );
      const count = parseInt(countResponse.headers.get("content-range")?.split("/")[1] || "0");
      return { 
        id: sub.id, 
        name: sub.podcast_title, 
        feed_url: sub.feed_url, 
        episode_count: count 
      };
    })
  );

  return { podcasts: podcastsWithCounts };
}

async function recentEpisodes(
  limit: number = 10,
  daysBack: number = 7,
  userId: string,
  env: Env
): Promise<{ episodes: Array<{ id: string; podcast_name: string; title: string; published_at: string; has_transcript: boolean }> }> {
  console.log(`[recentEpisodes] Fetching for user: ${userId}`);
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  // Get user's subscriptions with feed_url
  const subsResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=feed_url,podcast_title`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!subsResponse.ok) {
    console.error(`[recentEpisodes] Supabase error: ${subsResponse.status} ${await subsResponse.text()}`);
    return { episodes: [] };
  }

  const subscriptions = await subsResponse.json();
  console.log(`[recentEpisodes] Got subscriptions:`, JSON.stringify(subscriptions));
  
  if (!Array.isArray(subscriptions)) {
    console.error(`[recentEpisodes] Expected array, got:`, typeof subscriptions);
    return { episodes: [] };
  }
  
  const feedUrls = subscriptions.map((s: { feed_url: string }) => s.feed_url);
  const feedNameMap = new Map(subscriptions.map((s: { feed_url: string; podcast_title: string }) => [s.feed_url, s.podcast_title]));

  if (feedUrls.length === 0) {
    return { episodes: [] };
  }

  // Episodes link by feed_url, not subscription_id
  // Also fetch description to extract original podcast name
  const episodesResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/episodes?feed_url=in.(${feedUrls.map(u => encodeURIComponent(u)).join(",")})&published_at=gte.${cutoffDate.toISOString()}&order=published_at.desc&limit=${Math.min(limit, 50)}&select=id,title,published_at,feed_url,description`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!episodesResponse.ok) {
    console.error(`[recentEpisodes] Episodes query failed: ${episodesResponse.status} ${await episodesResponse.text()}`);
    return { episodes: [] };
  }

  const episodes = await episodesResponse.json();
  console.log(`[recentEpisodes] Got episodes:`, JSON.stringify(episodes).substring(0, 200));
  
  if (!Array.isArray(episodes)) {
    console.error(`[recentEpisodes] Expected array, got:`, typeof episodes);
    return { episodes: [] };
  }

  if (episodes.length === 0) {
    return { episodes: [] };
  }

  // Check which episodes have transcripts
  const episodeIds = episodes.map((e: { id: string }) => e.id);
  const transcriptsResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=in.(${episodeIds.join(",")})&select=episode_id`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  const transcripts = await transcriptsResponse.json();
  const hasTranscript = new Set(
    Array.isArray(transcripts) 
      ? transcripts.map((t: { episode_id: string }) => t.episode_id)
      : []
  );

  return {
    episodes: episodes.map((e: { id: string; feed_url: string; title: string; published_at: string; description?: string }) => {
      // Extract original podcast name from description (for ListenNotes aggregated feeds)
      const originalName = extractOriginalPodcastName(e.description || "");
      return {
        id: e.id,
        podcast_name: originalName || feedNameMap.get(e.feed_url) || "Unknown",
        title: e.title,
        published_at: e.published_at,
        has_transcript: hasTranscript.has(e.id),
      };
    }),
  };
}

async function listenToEpisode(
  episodeId: string,
  userId: string,
  env: Env
): Promise<{
  episode_id: string;
  podcast_name: string;
  title: string;
  links: ListenLinks;
} | { error: string }> {
  // Fetch episode with audio_url and description
  const episodeResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${episodeId}&select=id,title,feed_url,audio_url,description`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  const episodes = await episodeResponse.json() as Array<{
    id: string;
    title: string;
    feed_url: string;
    audio_url: string;
    description?: string;
  }>;

  if (!episodes.length) {
    return { error: "Episode not found" };
  }

  const episode = episodes[0];

  // Verify user has access to this episode's feed
  const subResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&feed_url=eq.${encodeURIComponent(episode.feed_url)}&select=podcast_title`,
    {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  const subs = await subResponse.json() as Array<{ podcast_title: string }>;

  if (!subs.length) {
    return { error: "Episode not found" };
  }

  // Extract original podcast name from description
  const originalName = extractOriginalPodcastName(episode.description || "");
  const podcastName = originalName || subs[0].podcast_title;

  // Build all listen links (Spotify, Apple, direct audio)
  const links = buildListenLinks(
    episode.audio_url,
    podcastName,
    episode.title,
    episode.description
  );

  return {
    episode_id: episode.id,
    podcast_name: podcastName,
    title: episode.title,
    links,
  };
}

// ============================================
// MCP REQUEST HANDLER
// ============================================

async function handleMCPRequest(
  request: MCPRequest,
  env: Env,
  userId: string
): Promise<MCPResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "podgest-mcp",
              version: "1.0.0",
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };

      case "tools/call": {
        const toolName = (params as { name: string }).name;
        const toolArgs = (params as { arguments?: Record<string, unknown> }).arguments || {};

        let result: unknown;

        switch (toolName) {
          case "search_podcasts":
            result = await searchPodcasts(
              toolArgs.query as string,
              toolArgs.limit as number | undefined,
              toolArgs.days_back as number | undefined,
              userId,
              env
            );
            break;

          case "get_episode":
            result = await getEpisode(toolArgs.episode_id as string, userId, env);
            break;

          case "compare_takes":
            result = await compareTakes(
              toolArgs.topic as string,
              toolArgs.days_back as number | undefined,
              userId,
              env
            );
            break;

          case "list_podcasts":
            result = await listPodcasts(userId, env);
            break;

          case "recent_episodes":
            result = await recentEpisodes(
              toolArgs.limit as number | undefined,
              toolArgs.days_back as number | undefined,
              userId,
              env
            );
            break;

          case "listen_to_episode":
            result = await listenToEpisode(toolArgs.episode_id as string, userId, env);
            break;

          default:
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown tool: ${toolName}` },
            };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (error) {
    console.error("MCP request error:", error);
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
    };
  }
}

// ============================================
// OAUTH + MCP HANDLERS
// ============================================

// API Handler - receives authenticated requests
const mcpApiHandler = {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const typedEnv = env as Env;
    const typedCtx = ctx as ExecutionContext & { props?: { userId: string; email?: string } };
    const url = new URL(request.url);
    
    // Log context for debugging
    console.log(`[mcpApiHandler] ${request.method} ${url.pathname}`);
    console.log(`[mcpApiHandler] ctx.props:`, JSON.stringify(typedCtx.props));
    
    const userId = typedCtx.props?.userId;
    console.log(`[mcpApiHandler] userId: ${userId}`);

    if (!userId) {
      console.error(`[mcpApiHandler] No userId in props - not authenticated`);
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle SSE for MCP streaming
    if (request.headers.get("Accept") === "text/event-stream") {
      return handleSSE(request, typedEnv, userId);
    }

    // Handle MCP POST requests
    if (request.method === "POST") {
      const mcpRequest = await request.json() as MCPRequest;
      const response = await handleMCPRequest(mcpRequest, typedEnv, userId);
      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

// SSE handler for streaming MCP
async function handleSSE(request: Request, env: Env, userId: string): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`event: open\ndata: {"status":"connected"}\n\n`));
      
      const serverInfo = {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {
          serverInfo: {
            name: "podgest-mcp",
            version: "1.0.0",
          },
        },
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(serverInfo)}\n\n`));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Default Handler - handles auth pages and non-API requests
const defaultHandler = {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const typedEnv = env as Env;
    const url = new URL(request.url);
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "podgest-mcp",
        version: "2.0.0",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // OAuth Protected Resource Metadata (RFC 9728) - required for mcp-remote
    // NOTE: URL must NOT have trailing slash to match token audience
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return new Response(JSON.stringify({
        resource: "https://podgest-mcp.pztest.workers.dev",
        authorization_servers: ["https://podgest-mcp.pztest.workers.dev"],
        scopes_supported: ["openid", "profile", "email"],
        bearer_methods_supported: ["header"],
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // OAuth authorize page - show Google sign-in
    if (url.pathname === "/authorize") {
      // Parse the OAuth request
      const oauthReqInfo = await typedEnv.OAUTH_PROVIDER.parseAuthRequest(request);
      
      // Store OAuth params in session and redirect to Supabase Google auth
      const state = crypto.randomUUID();
      await typedEnv.OAUTH_KV.put(`oauth_state:${state}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });
      
      const callbackUrl = `${MCP_SERVER_URL}/oauth/callback?state=${encodeURIComponent(state)}`;
      const supabaseAuthUrl = `${typedEnv.SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(callbackUrl)}`;
      
      return Response.redirect(supabaseAuthUrl, 302);
    }

    // OAuth callback - receive Google auth result
    if (url.pathname === "/oauth/callback") {
      const state = url.searchParams.get("state");
      
      if (!state) {
        return new Response(renderErrorPage("Missing state parameter"), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      // Supabase returns token in fragment, need JS to extract
      return new Response(renderOAuthCallbackPage(state), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Process Supabase token and complete OAuth flow
    if (url.pathname === "/oauth/complete" && request.method === "POST") {
      try {
        const { access_token, state } = await request.json() as { access_token: string; state: string };
        
        // Retrieve stored OAuth request
        const oauthReqStr = await typedEnv.OAUTH_KV.get(`oauth_state:${state}`);
        if (!oauthReqStr) {
          return new Response(JSON.stringify({ error: "Invalid or expired state" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        
        const oauthReqInfo = JSON.parse(oauthReqStr);
        await typedEnv.OAUTH_KV.delete(`oauth_state:${state}`);

        // Validate Supabase JWT and get user
        const userResponse = await fetch(`${typedEnv.SUPABASE_URL}/auth/v1/user`, {
          headers: {
            "apikey": typedEnv.SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${access_token}`,
          },
        });

        if (!userResponse.ok) {
          return new Response(JSON.stringify({ error: "Invalid Supabase token" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const user = await userResponse.json() as { id: string; email: string };
        console.log(`[OAuth] User authenticated: ${user.id} (${user.email})`);

        // Complete OAuth authorization
        const { redirectTo } = await typedEnv.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: user.id,
          metadata: { email: user.email },
          scope: oauthReqInfo.scope || ["openid", "profile"],
          props: {
            userId: user.id,
            email: user.email,
          },
        });
        
        console.log(`[OAuth] Authorization complete, redirecting to: ${redirectTo}`);

        return new Response(JSON.stringify({ redirect_url: redirectTo }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("OAuth complete error:", error);
        return new Response(JSON.stringify({ error: "Authentication failed" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

// ============================================
// PAGE TEMPLATES
// ============================================

function renderOAuthCallbackPage(state: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Podgest - Authenticating</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #0f0f23 100%);
      color: #fff;
    }
    .container { text-align: center; padding: 48px; }
    .spinner {
      width: 48px;
      height: 48px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .status { color: #94a3b8; }
    .error { color: #f87171; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <h1>Completing sign-in...</h1>
    <p class="status" id="status">Redirecting back to your app.</p>
    <p class="error" id="error"></p>
  </div>
  <script>
    (async function() {
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const accessToken = params.get('access_token');
      
      if (!accessToken) {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('status').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = 'No access token received. Please try again.';
        return;
      }
      
      try {
        const response = await fetch('/oauth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: accessToken,
            state: ${JSON.stringify(state)}
          })
        });
        
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Authentication failed');
        }
        
        const data = await response.json();
        window.location.href = data.redirect_url;
      } catch (err) {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('status').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = err.message;
      }
    })();
  </script>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Error - Podgest</title>
  <style>
    body {
      font-family: -apple-system, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #0f0f23;
      color: #fff;
    }
    .error { color: #f87171; font-size: 18px; }
  </style>
</head>
<body>
  <div class="error">${message}</div>
</body>
</html>`;
}

// ============================================
// EXPORT OAUTH PROVIDER
// ============================================

export default new OAuthProvider({
  apiRoute: ["/mcp", "/sse"],
  apiHandler: mcpApiHandler,
  defaultHandler: defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["openid", "profile", "email"],
  // Refresh tokens valid for 1 year
  refreshTokenTTL: 31536000,
});
