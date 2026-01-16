/**
 * Podgest MCP Server
 * 
 * Model Context Protocol server for querying podcast transcripts via Claude Desktop.
 * Uses Cloudflare Workers with OAuth authentication.
 * 
 * Tools:
 * - search_podcasts: Semantic search across all transcripts
 * - get_episode: Get episode details and transcript URL
 * - compare_takes: Compare perspectives across podcasts on a topic
 * - list_podcasts: List subscribed podcasts
 * - recent_episodes: Get recent episodes
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPERMEMORY_API_KEY: string;
  // OAuth secrets (for future)
  // GOOGLE_CLIENT_ID: string;
  // GOOGLE_CLIENT_SECRET: string;
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
];

// ============================================
// TOOL IMPLEMENTATIONS
// ============================================

async function searchPodcasts(
  params: { query: string; limit?: number; days_back?: number },
  env: Env,
  userId: string
): Promise<unknown> {
  const limit = Math.min(params.limit || 5, 20);
  
  // Search SuperMemory with user's container tag
  const searchResponse = await fetch("https://api.supermemory.ai/v3/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUPERMEMORY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: params.query, // SuperMemory uses 'q' not 'query'
      limit,
      containerTags: [userId], // Multi-tenancy filter
    }),
  });

  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    throw new Error(`SuperMemory search failed: ${searchResponse.status} - ${errorText}`);
  }

  const searchData = await searchResponse.json() as {
    results: Array<{
      chunks: Array<{
        content: string;
        score: number;
      }>;
      metadata: {
        episode_id: string;
        episode_title: string;
        podcast_title: string;
        published_at: number;
        summary?: string;
      };
      score: number;
      title: string;
    }>;
    total: number;
  };

  return {
    query: params.query,
    results: searchData.results.map(r => {
      // Get the best chunk content
      const bestChunk = r.chunks?.[0]?.content || "";
      return {
        podcast: r.metadata?.podcast_title || "Unknown",
        episode: r.metadata?.episode_title || r.title || "Unknown",
        episode_id: r.metadata?.episode_id,
        published: r.metadata?.published_at 
          ? new Date(r.metadata.published_at).toISOString().split('T')[0]
          : "Unknown",
        excerpt: bestChunk.substring(0, 500) + (bestChunk.length > 500 ? "..." : ""),
        relevance: Math.round(r.score * 100) / 100,
      };
    }),
    total_results: searchData.total,
  };
}

async function getEpisode(
  params: { episode_id: string },
  env: Env,
  userId: string
): Promise<unknown> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // Get episode with subscription info (to verify user access)
  const episodeResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${params.episode_id}&select=*`,
    { headers }
  );

  if (!episodeResponse.ok) {
    throw new Error("Failed to fetch episode");
  }

  const episodes = await episodeResponse.json() as Array<{
    id: string;
    title: string;
    description: string;
    audio_url: string;
    published_at: string;
    duration_seconds: number;
    feed_url: string;
  }>;

  if (!episodes.length) {
    throw new Error("Episode not found");
  }

  const episode = episodes[0];

  // Get subscription to verify user access and get podcast title
  const subResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?feed_url=eq.${encodeURIComponent(episode.feed_url)}&user_id=eq.${userId}&select=podcast_title`,
    { headers }
  );

  const subs = await subResponse.json() as Array<{ podcast_title: string }>;
  if (!subs.length) {
    throw new Error("You don't have access to this episode");
  }

  // Get transcription and topic extraction
  const transcriptionResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${params.episode_id}&select=id,transcript_storage_path,word_count,language`,
    { headers }
  );

  const transcriptions = await transcriptionResponse.json() as Array<{
    id: string;
    transcript_storage_path: string;
    word_count: number;
    language: string;
  }>;

  let topics = null;
  let summary = null;

  if (transcriptions.length) {
    const topicsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/topic_extractions?transcription_id=eq.${transcriptions[0].id}&select=topics`,
      { headers }
    );

    const topicData = await topicsResponse.json() as Array<{ topics: { summary: string; topics: string[]; key_points: string[] } }>;
    if (topicData.length) {
      topics = topicData[0].topics.topics;
      summary = topicData[0].topics.summary;
    }
  }

  // Generate signed URL for transcript (valid 1 hour)
  let transcriptUrl = null;
  if (transcriptions.length && transcriptions[0].transcript_storage_path) {
    const signResponse = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/sign/transcripts/${transcriptions[0].transcript_storage_path}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );

    if (signResponse.ok) {
      const signData = await signResponse.json() as { signedURL: string };
      transcriptUrl = `${env.SUPABASE_URL}/storage/v1${signData.signedURL}`;
    }
  }

  return {
    id: episode.id,
    title: episode.title,
    podcast: subs[0].podcast_title,
    published: episode.published_at,
    duration_minutes: Math.round((episode.duration_seconds || 0) / 60),
    description: episode.description?.substring(0, 300),
    summary,
    topics,
    word_count: transcriptions[0]?.word_count,
    language: transcriptions[0]?.language,
    transcript_url: transcriptUrl,
    audio_url: episode.audio_url,
  };
}

async function compareTakes(
  params: { topic: string; days_back?: number },
  env: Env,
  userId: string
): Promise<unknown> {
  const daysBack = params.days_back || 30;

  // Search for the topic across all user's podcasts
  const searchResponse = await fetch("https://api.supermemory.ai/v3/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUPERMEMORY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: params.topic, // SuperMemory uses 'q' not 'query'
      limit: 20,
      containerTags: [userId],
    }),
  });

  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    throw new Error(`SuperMemory search failed: ${searchResponse.status} - ${errorText}`);
  }

  const searchData = await searchResponse.json() as {
    results: Array<{
      chunks: Array<{
        content: string;
        score: number;
      }>;
      metadata: {
        episode_id: string;
        episode_title: string;
        podcast_title: string;
        published_at: number;
        summary?: string;
      };
      score: number;
      title: string;
    }>;
    total: number;
  };

  // Group by podcast and take best result per podcast
  const byPodcast = new Map<string, typeof searchData.results[0]>();
  for (const result of searchData.results) {
    const podcast = result.metadata?.podcast_title || "Unknown";
    if (!byPodcast.has(podcast) || byPodcast.get(podcast)!.score < result.score) {
      byPodcast.set(podcast, result);
    }
  }

  const perspectives = Array.from(byPodcast.values()).map(r => {
    const bestChunk = r.chunks?.[0]?.content || "";
    return {
      podcast: r.metadata?.podcast_title || "Unknown",
      episode: r.metadata?.episode_title || r.title || "Unknown",
      episode_id: r.metadata?.episode_id,
      published: r.metadata?.published_at 
        ? new Date(r.metadata.published_at).toISOString().split('T')[0]
        : "Unknown",
      excerpt: bestChunk.substring(0, 400) + (bestChunk.length > 400 ? "..." : ""),
      relevance: Math.round(r.score * 100) / 100,
    };
  });

  return {
    topic: params.topic,
    days_searched: daysBack,
    podcasts_found: perspectives.length,
    perspectives: perspectives.sort((a, b) => b.relevance - a.relevance),
  };
}

async function listPodcasts(
  env: Env,
  userId: string
): Promise<unknown> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&is_active=eq.true&select=id,podcast_title,feed_url,priority,last_polled_at`,
    { headers }
  );

  if (!response.ok) {
    throw new Error("Failed to fetch subscriptions");
  }

  const subs = await response.json() as Array<{
    id: string;
    podcast_title: string;
    feed_url: string;
    priority: number;
    last_polled_at: string;
  }>;

  return {
    total: subs.length,
    podcasts: subs.map(s => ({
      id: s.id,
      title: s.podcast_title,
      priority: s.priority,
      last_checked: s.last_polled_at,
    })),
  };
}

async function recentEpisodes(
  params: { limit?: number; days_back?: number },
  env: Env,
  userId: string
): Promise<unknown> {
  const limit = Math.min(params.limit || 10, 50);
  const daysBack = params.days_back || 7;
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // Get user's subscribed feed URLs
  const subsResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&is_active=eq.true&select=feed_url,podcast_title`,
    { headers }
  );

  const subs = await subsResponse.json() as Array<{ feed_url: string; podcast_title: string }>;
  if (!subs.length) {
    return { episodes: [], total: 0 };
  }

  const feedUrls = subs.map(s => s.feed_url);
  const feedToTitle = new Map(subs.map(s => [s.feed_url, s.podcast_title]));

  // Get recent episodes from those feeds
  const episodesResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/episodes?feed_url=in.(${feedUrls.map(u => `"${u}"`).join(",")})&published_at=gte.${cutoff}&order=published_at.desc&limit=${limit}&select=id,title,published_at,duration_seconds,feed_url`,
    { headers }
  );

  const episodes = await episodesResponse.json() as Array<{
    id: string;
    title: string;
    published_at: string;
    duration_seconds: number;
    feed_url: string;
  }>;

  return {
    days_back: daysBack,
    total: episodes.length,
    episodes: episodes.map(e => ({
      id: e.id,
      title: e.title,
      podcast: feedToTitle.get(e.feed_url) || "Unknown",
      published: e.published_at,
      duration_minutes: Math.round((e.duration_seconds || 0) / 60),
    })),
  };
}

// ============================================
// MCP PROTOCOL HANDLER
// ============================================

async function handleMCPRequest(
  request: MCPRequest,
  env: Env,
  userId: string
): Promise<MCPResponse> {
  const { id, method, params } = request;

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
          result: {
            tools: TOOLS,
          },
        };

      case "tools/call": {
        const toolParams = params as { name: string; arguments: Record<string, unknown> };
        const toolName = toolParams.name;
        const toolArgs = toolParams.arguments || {};

        let result: unknown;

        switch (toolName) {
          case "search_podcasts":
            result = await searchPodcasts(toolArgs as { query: string; limit?: number; days_back?: number }, env, userId);
            break;
          case "get_episode":
            result = await getEpisode(toolArgs as { episode_id: string }, env, userId);
            break;
          case "compare_takes":
            result = await compareTakes(toolArgs as { topic: string; days_back?: number }, env, userId);
            break;
          case "list_podcasts":
            result = await listPodcasts(env, userId);
            break;
          case "recent_episodes":
            result = await recentEpisodes(toolArgs as { limit?: number; days_back?: number }, env, userId);
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      }

      case "notifications/initialized":
        // Client notification, no response needed
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================
// HTTP HANDLER (SSE for MCP)
// ============================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "podgest-mcp",
        version: "1.0.0",
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // MCP endpoint - supports both SSE and simple POST
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      // For now, use a hardcoded user ID for testing
      // TODO: Implement OAuth flow using Cloudflare's workers-oauth-provider
      const userId = url.searchParams.get("user_id") || "18f513bd-8ecf-4922-84b7-4ab7c7cc14df";

      // Handle SSE connection for streaming
      if (request.headers.get("Accept") === "text/event-stream") {
        return handleSSE(request, env, userId);
      }

      // Handle simple POST request
      if (request.method === "POST") {
        const mcpRequest = await request.json() as MCPRequest;
        const response = await handleMCPRequest(mcpRequest, env, userId);
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // OAuth endpoints (placeholder for future)
    if (url.pathname === "/oauth/authorize") {
      // TODO: Implement OAuth authorization
      return new Response("OAuth not yet implemented", { status: 501 });
    }

    if (url.pathname === "/oauth/callback") {
      // TODO: Implement OAuth callback
      return new Response("OAuth not yet implemented", { status: 501 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// SSE handler for streaming MCP
async function handleSSE(request: Request, env: Env, userId: string): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection event
      controller.enqueue(encoder.encode(`event: open\ndata: {"status":"connected"}\n\n`));

      // For SSE, we need to handle incoming messages differently
      // This is a simplified implementation - full SSE would use WebSockets or long-polling
      
      // Send server info
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
