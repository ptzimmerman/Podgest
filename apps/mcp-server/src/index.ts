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
 * - save_memory / recall / list_memories / forget: Personal memory layer
 *
 * Data layer: Cloudflare D1 (relational), Vectorize (embeddings), R2 (transcripts).
 * Auth still delegates to Supabase — TODO(Phase 5): Better Auth.
 */

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { searchTranscripts, getUserOpenAIKey, type TranscriptSearchResult } from "./vectorsearch";
import { generateEmbedding } from "./embeddings";
import { one, all, run, parseJson, placeholders } from "./db";

// Env interface with OAuth Provider bindings
export interface Env {
  USER_ENCRYPTION_KEY: string;  // For decrypting user API keys
  // Cloudflare-native data layer
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  TRANSCRIPTS: R2Bucket;  // private bucket for transcript JSON (`<episode_id>/transcript.json`)
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

const MCP_SERVER_URL = "https://mcp.podgest.app";

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
    description: "Semantic search across all podcast transcripts. Returns relevant excerpts with source attribution (podcast_name is the episode's real show name, even for episodes that arrived via an aggregator feed).",
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
    description: "Find how different podcasts covered the same topic. Returns contrasting perspectives, grouped by each episode's real show name (aggregator feeds are resolved to the underlying shows).",
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
    description: "List all podcast subscriptions. A subscription may be an aggregator feed (e.g. a ListenNotes playlist) that bundles many different shows into one RSS feed - these are marked is_aggregator=true and include shows_included listing the real shows inside. Treat those shows as if the user subscribed to each individually; other tools already resolve episodes to their real show names.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "recent_episodes",
    description: "Get the most recent episodes across all subscribed podcasts. podcast_name is always the episode's real show name, even when the episode arrived via an aggregator feed.",
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
  {
    name: "get_transcript",
    description: "Get the full transcript text for a specific podcast episode. Returns the complete transcript content directly.",
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
    name: "get_digest_transcript",
    description: "Get the script/transcript of a Podgest daily digest episode. If no date is specified, returns the latest digest.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format (optional, defaults to latest digest)",
        },
      },
    },
  },
  {
    name: "save_memory",
    description: "Save a memory (note, fact, or insight) for later semantic recall. Memories are organized into freeform namespaces (suggested: 'podcasts', 'trading'; default: 'general'). Returns the new memory's id.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text content to remember",
        },
        namespace: {
          type: "string",
          description: "Freeform namespace to file the memory under (e.g. 'podcasts', 'trading'; default: 'general')",
        },
        metadata: {
          type: "object",
          description: "Optional arbitrary JSON metadata to store alongside the memory",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description: "Semantically search saved memories and return the most relevant ones with similarity scores. Optionally restrict to a namespace (e.g. 'podcasts', 'trading').",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language query describing what to recall",
        },
        namespace: {
          type: "string",
          description: "Only recall memories from this namespace (e.g. 'podcasts', 'trading'; optional)",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (default: 5, max: 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_memories",
    description: "List saved memories, most recent first. Optionally filter by namespace (e.g. 'podcasts', 'trading').",
    inputSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description: "Only list memories from this namespace (e.g. 'podcasts', 'trading'; optional)",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (default: 20, max: 100)",
        },
      },
    },
  },
  {
    name: "forget",
    description: "Permanently delete a saved memory by id.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "The id of the memory to delete (as returned by save_memory or recall/list_memories)",
        },
      },
      required: ["memory_id"],
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
): Promise<{ results: Array<{ episode_id: string; podcast_name: string; title: string; excerpt: string; published_at: string }> } | { error: string }> {
  // Get user's OpenAI key for generating embeddings
  const openaiKey = await getUserOpenAIKey(env.DB, userId, env.USER_ENCRYPTION_KEY);

  if (!openaiKey) {
    return { 
      error: "Search requires an OpenAI API key. Please add your OpenAI API key in the Podgest settings at https://podgest.app/settings"
    };
  }

  try {
    // Search using Vectorize
    const results = await searchTranscripts(
      query,
      userId,
      openaiKey,
      env.VECTORIZE,
      env.DB,
      { limit: Math.min(limit, 20) }
    );

    if (daysBack) {
      // Log for debugging - date filtering could be added to the Vectorize filter in future
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);
      console.log(`[searchPodcasts] Date filter requested: >= ${cutoffDate.toISOString()}`);
    }

    // Fetch episode published dates to include in results
    const episodeIds = [...new Set(results.map(r => r.episode_id))];
    let episodeDates: Map<string, string> = new Map();

    if (episodeIds.length > 0) {
      const episodes = await all<{ id: string; published_at: string }>(
        env.DB,
        `SELECT id, published_at FROM episodes WHERE id IN (${placeholders(episodeIds.length)})`,
        ...episodeIds
      );
      episodeDates = new Map(episodes.map(e => [e.id, e.published_at]));
    }

    return {
      results: results.map((r) => ({
        episode_id: r.episode_id,
        podcast_name: r.podcast_title || "Unknown",
        title: r.episode_title || "Unknown",
        excerpt: r.chunk_text?.substring(0, 500) || "No content available",
        published_at: episodeDates.get(r.episode_id) || "",
      })),
    };
  } catch (error) {
    console.error("[searchPodcasts] Error:", error);
    if (error instanceof Error) {
      // Return user-friendly error for known issues
      if (error.message.includes('Invalid OpenAI API key')) {
        return { error: "Your OpenAI API key is invalid. Please update it in Podgest settings." };
      }
      if (error.message.includes('rate limit')) {
        return { error: "OpenAI rate limit exceeded. Please try again in a moment." };
      }
      return { error: `Search failed: ${error.message}` };
    }
    return { error: "Search failed. Please try again." };
  }
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
  transcript_excerpt?: string;
  has_full_transcript?: boolean;
  listen_links?: ListenLinks;
} | { error: string }> {
  // Fetch episode with description and audio_url
  const episode = await one<{
    id: string;
    title: string;
    published_at: string;
    feed_url: string;
    description: string | null;
    audio_url: string;
  }>(
    env.DB,
    `SELECT id, title, published_at, feed_url, description, audio_url FROM episodes WHERE id = ?`,
    episodeId
  );

  if (!episode) {
    return { error: "Episode not found" };
  }
  
  // Verify user has a subscription for this episode's feed
  const sub = await one<{ podcast_title: string | null }>(
    env.DB,
    `SELECT podcast_title FROM subscriptions WHERE user_id = ? AND feed_url = ?`,
    userId,
    episode.feed_url
  );
  
  if (!sub) {
    return { error: "Episode not found" };
  }
  
  // Extract original podcast name from description (for ListenNotes aggregated feeds)
  const originalName = extractOriginalPodcastName(episode.description || "");
  const podcastTitle = originalName || sub.podcast_title || "Unknown";

  // Get transcription
  const transcription = await one<{ transcript_storage_path: string | null }>(
    env.DB,
    `SELECT transcript_storage_path FROM transcriptions WHERE episode_id = ?`,
    episodeId
  );
  
  // Get topic extraction (topics is a TEXT JSON column; D1 schema has no summary column)
  let summary: string | undefined;
  let topics: string[] | undefined;
  
  const topicRow = await one<{ topics: string | null }>(
    env.DB,
    `SELECT te.topics FROM topic_extractions te
     JOIN transcriptions t ON t.id = te.transcription_id
     WHERE t.episode_id = ?`,
    episodeId
  );
  if (topicRow) {
    topics = parseJson<string[] | undefined>(topicRow.topics, undefined);
  }

  // Fetch transcript content directly from R2
  let transcriptExcerpt: string | undefined;
  if (transcription?.transcript_storage_path) {
    const transcriptObject = await env.TRANSCRIPTS.get(`${episodeId}/transcript.json`);
    if (transcriptObject) {
      const transcriptData = await transcriptObject.json() as { text?: string };
      if (transcriptData.text) {
        transcriptExcerpt = transcriptData.text.substring(0, 5000);
      }
    }
  }

  return {
    episode_id: episode.id,
    podcast_name: podcastTitle,
    title: episode.title,
    published_at: episode.published_at,
    summary,
    topics,
    transcript_excerpt: transcriptExcerpt,
    has_full_transcript: !!transcriptExcerpt,
  };
}

async function compareTakes(
  topic: string,
  daysBack: number = 30,
  userId: string,
  env: Env
): Promise<{ perspectives: Array<{ podcast_name: string; episode_title: string; take: string; published_at: string }> } | { error: string }> {
  // Get user's OpenAI key for generating embeddings
  const openaiKey = await getUserOpenAIKey(env.DB, userId, env.USER_ENCRYPTION_KEY);

  if (!openaiKey) {
    return { 
      error: "Comparing takes requires an OpenAI API key. Please add your OpenAI API key in the Podgest settings at https://podgest.app/settings"
    };
  }

  try {
    // Log date filter intent
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    console.log(`[compareTakes] Date filter requested: >= ${cutoffDate.toISOString()}`);

    // Search using Vectorize
    const results = await searchTranscripts(
      topic,
      userId,
      openaiKey,
      env.VECTORIZE,
      env.DB,
      { limit: 15 }  // Get more results to find diverse perspectives
    );

    // Fetch episode published dates
    const episodeIds = [...new Set(results.map(r => r.episode_id))];
    let episodeDates: Map<string, string> = new Map();

    if (episodeIds.length > 0) {
      const episodes = await all<{ id: string; published_at: string }>(
        env.DB,
        `SELECT id, published_at FROM episodes WHERE id IN (${placeholders(episodeIds.length)})`,
        ...episodeIds
      );
      episodeDates = new Map(episodes.map(e => [e.id, e.published_at]));
    }

    // Group by podcast and take best result from each
    const byPodcast = new Map<string, TranscriptSearchResult>();
    for (const result of results) {
      const podcastName = result.podcast_title || "Unknown";
      if (!byPodcast.has(podcastName)) {
        byPodcast.set(podcastName, result);
      }
    }

    return {
      perspectives: Array.from(byPodcast.values()).map((r) => ({
        podcast_name: r.podcast_title || "Unknown",
        episode_title: r.episode_title || "Unknown",
        take: r.chunk_text?.substring(0, 800) || "No content",
        published_at: episodeDates.get(r.episode_id) || "",
      })),
    };
  } catch (error) {
    console.error("[compareTakes] Error:", error);
    if (error instanceof Error) {
      if (error.message.includes('Invalid OpenAI API key')) {
        return { error: "Your OpenAI API key is invalid. Please update it in Podgest settings." };
      }
      if (error.message.includes('rate limit')) {
        return { error: "OpenAI rate limit exceeded. Please try again in a moment." };
      }
      return { error: `Compare failed: ${error.message}` };
    }
    return { error: "Compare failed. Please try again." };
  }
}

interface PodcastListing {
  id: string;
  name: string;
  feed_url: string;
  episode_count: number;
  is_aggregator: boolean;
  // Aggregator feeds only: the real shows bundled inside, by recent episode volume
  shows_included?: Array<{ name: string; recent_episode_count: number }>;
  note?: string;
}

async function listPodcasts(
  userId: string,
  env: Env
): Promise<{ podcasts: PodcastListing[] }> {
  console.log(`[listPodcasts] Fetching for user: ${userId}`);
  
  // Episodes link by feed_url, so count them in a single joined query
  const rows = await all<{ id: string; podcast_title: string | null; feed_url: string; episode_count: number }>(
    env.DB,
    `SELECT s.id, s.podcast_title, s.feed_url,
            (SELECT COUNT(*) FROM episodes e WHERE e.feed_url = s.feed_url) AS episode_count
     FROM subscriptions s
     WHERE s.user_id = ?`,
    userId
  );

  const podcasts: PodcastListing[] = [];
  for (const r of rows) {
    // Detect aggregator feeds by scanning recent episode descriptions for the
    // embedded original-show marker (works for ListenNotes playlists; a plain
    // single-show feed never carries it).
    const recentEpisodes = await all<{ description: string | null }>(
      env.DB,
      `SELECT substr(description, 1, 4000) AS description
       FROM episodes WHERE feed_url = ?
       ORDER BY published_at DESC LIMIT 200`,
      r.feed_url
    );

    const showCounts = new Map<string, number>();
    for (const ep of recentEpisodes) {
      const name = extractOriginalPodcastName(ep.description || "");
      if (name) showCounts.set(name, (showCounts.get(name) || 0) + 1);
    }

    const isAggregator = showCounts.size > 0;
    podcasts.push({
      id: r.id,
      name: r.podcast_title || "Unknown",
      feed_url: r.feed_url,
      episode_count: r.episode_count,
      is_aggregator: isAggregator,
      ...(isAggregator
        ? {
            shows_included: [...showCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => ({ name, recent_episode_count: count })),
            note:
              "This is an aggregator feed (e.g. a ListenNotes playlist) bundling episodes from the shows listed in shows_included. " +
              "Treat each of those shows as an individual subscription: recent_episodes, search_podcasts, compare_takes, and " +
              "get_episode already resolve every episode to its real show name, so query them normally.",
          }
        : {}),
    });
  }

  return { podcasts };
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
  const subscriptions = await all<{ feed_url: string; podcast_title: string | null }>(
    env.DB,
    `SELECT feed_url, podcast_title FROM subscriptions WHERE user_id = ?`,
    userId
  );
  
  const feedUrls = subscriptions.map(s => s.feed_url);
  const feedNameMap = new Map(subscriptions.map(s => [s.feed_url, s.podcast_title]));

  if (feedUrls.length === 0) {
    return { episodes: [] };
  }

  // Episodes link by feed_url, not subscription_id
  // Also fetch description to extract original podcast name
  const episodes = await all<{ id: string; title: string; published_at: string; feed_url: string; description: string | null }>(
    env.DB,
    `SELECT id, title, published_at, feed_url, description
     FROM episodes
     WHERE feed_url IN (${placeholders(feedUrls.length)})
       AND published_at >= ?
     ORDER BY published_at DESC
     LIMIT ?`,
    ...feedUrls,
    cutoffDate.toISOString(),
    Math.min(limit, 50)
  );

  if (episodes.length === 0) {
    return { episodes: [] };
  }

  // Check which episodes have transcripts
  const episodeIds = episodes.map(e => e.id);
  const transcripts = await all<{ episode_id: string }>(
    env.DB,
    `SELECT episode_id FROM transcriptions WHERE episode_id IN (${placeholders(episodeIds.length)})`,
    ...episodeIds
  );
  const hasTranscript = new Set(transcripts.map(t => t.episode_id));

  return {
    episodes: episodes.map((e) => {
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

async function getDigestTranscript(
  userId: string,
  env: Env,
  date?: string
): Promise<{ digest_id: string; title: string; date: string; transcript: string } | { error: string }> {
  const digest = date
    ? await one<{ id: string; digest_date: string; script_text: string | null; topic_clusters: string | null }>(
        env.DB,
        `SELECT id, digest_date, script_text, topic_clusters FROM digests
         WHERE user_id = ? AND digest_date = ? AND status = 'completed' LIMIT 1`,
        userId,
        date
      )
    : await one<{ id: string; digest_date: string; script_text: string | null; topic_clusters: string | null }>(
        env.DB,
        `SELECT id, digest_date, script_text, topic_clusters FROM digests
         WHERE user_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
        userId
      );

  if (!digest) {
    return { error: date ? `No completed digest found for ${date}` : "No completed digests found" };
  }

  if (!digest.script_text) {
    return { error: "Digest exists but script text is not available" };
  }

  const topicClusters = parseJson<{ title?: string; topics?: string[] } | null>(digest.topic_clusters, null);

  return {
    digest_id: digest.id,
    title: topicClusters?.title || `Podgest - ${digest.digest_date}`,
    date: digest.digest_date,
    transcript: digest.script_text,
  };
}

async function getTranscript(
  episodeId: string,
  userId: string,
  env: Env
): Promise<{ episode_id: string; title: string; podcast_name: string; transcript: string } | { error: string }> {
  // Verify episode belongs to user's subscriptions
  const episode = await one<{ id: string; title: string; feed_url: string }>(
    env.DB,
    `SELECT id, title, feed_url FROM episodes WHERE id = ?`,
    episodeId
  );
  if (!episode) {
    return { error: "Episode not found" };
  }

  // Get podcast name from subscription
  const sub = await one<{ podcast_title: string | null }>(
    env.DB,
    `SELECT podcast_title FROM subscriptions WHERE user_id = ? AND feed_url = ?`,
    userId,
    episode.feed_url
  );
  const podcastName = sub?.podcast_title || "Unknown Podcast";

  // Fetch transcript content directly from R2
  const transcriptObject = await env.TRANSCRIPTS.get(`${episodeId}/transcript.json`);

  if (!transcriptObject) {
    return { error: "Transcript not available for this episode" };
  }

  const transcriptData = await transcriptObject.json() as { text?: string; segments?: Array<{ text: string }> };
  const transcriptText = transcriptData.text
    || transcriptData.segments?.map(s => s.text).join(" ")
    || "";

  if (!transcriptText) {
    return { error: "Transcript is empty" };
  }

  return {
    episode_id: episodeId,
    title: episode.title,
    podcast_name: podcastName,
    transcript: transcriptText,
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
  const episode = await one<{
    id: string;
    title: string;
    feed_url: string;
    audio_url: string;
    description: string | null;
  }>(
    env.DB,
    `SELECT id, title, feed_url, audio_url, description FROM episodes WHERE id = ?`,
    episodeId
  );

  if (!episode) {
    return { error: "Episode not found" };
  }

  // Verify user has access to this episode's feed
  const sub = await one<{ podcast_title: string | null }>(
    env.DB,
    `SELECT podcast_title FROM subscriptions WHERE user_id = ? AND feed_url = ?`,
    userId,
    episode.feed_url
  );

  if (!sub) {
    return { error: "Episode not found" };
  }

  // Extract original podcast name from description
  const originalName = extractOriginalPodcastName(episode.description || "");
  const podcastName = originalName || sub.podcast_title || "Unknown";

  // Build all listen links (Spotify, Apple, direct audio)
  const links = buildListenLinks(
    episode.audio_url,
    podcastName,
    episode.title,
    episode.description ?? undefined
  );

  return {
    episode_id: episode.id,
    podcast_name: podcastName,
    title: episode.title,
    links,
  };
}

// ============================================
// MEMORY TOOLS
// ============================================

async function saveMemory(
  content: string,
  namespace: string | undefined,
  metadata: Record<string, unknown> | undefined,
  userId: string,
  env: Env
): Promise<{ memory_id: string; namespace: string } | { error: string }> {
  if (!content || content.trim().length === 0) {
    return { error: "Memory content cannot be empty" };
  }

  const openaiKey = await getUserOpenAIKey(env.DB, userId, env.USER_ENCRYPTION_KEY);
  if (!openaiKey) {
    return {
      error: "Saving memories requires an OpenAI API key. Please add your OpenAI API key in the Podgest settings at https://podgest.app/settings"
    };
  }

  const ns = namespace?.trim() || "general";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    const values = await generateEmbedding(content, openaiKey);

    await run(
      env.DB,
      `INSERT INTO memories (id, user_id, namespace, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      ns,
      content,
      metadata ? JSON.stringify(metadata) : null,
      now,
      now
    );

    await env.VECTORIZE.upsert([{
      id,
      values,
      metadata: {
        type: "memory",
        user_id: userId,
        namespace: ns,
        created_at: now.slice(0, 10), // YYYY-MM-DD
      },
    }]);

    return { memory_id: id, namespace: ns };
  } catch (error) {
    console.error("[saveMemory] Error:", error);
    if (error instanceof Error) {
      if (error.message.includes("Invalid OpenAI API key")) {
        return { error: "Your OpenAI API key is invalid. Please update it in Podgest settings." };
      }
      return { error: `Failed to save memory: ${error.message}` };
    }
    return { error: "Failed to save memory. Please try again." };
  }
}

async function recallMemories(
  query: string,
  namespace: string | undefined,
  limit: number = 5,
  userId: string,
  env: Env
): Promise<{ memories: Array<{ memory_id: string; namespace: string; content: string; metadata: Record<string, unknown> | null; created_at: string; score: number }> } | { error: string }> {
  const openaiKey = await getUserOpenAIKey(env.DB, userId, env.USER_ENCRYPTION_KEY);
  if (!openaiKey) {
    return {
      error: "Recalling memories requires an OpenAI API key. Please add your OpenAI API key in the Podgest settings at https://podgest.app/settings"
    };
  }

  try {
    const queryEmbedding = await generateEmbedding(query, openaiKey);

    const filter: Record<string, unknown> = {
      type: "memory",
      user_id: userId,
      ...(namespace ? { namespace } : {}),
    };

    const matches = await env.VECTORIZE.query(queryEmbedding, {
      topK: Math.min(Math.max(limit, 1), 20),
      returnMetadata: "all",
      filter: filter as VectorizeVectorMetadataFilter,
    });

    if (!matches.matches.length) {
      return { memories: [] };
    }

    // Hydrate content/metadata from D1 (user_id check re-scopes for safety)
    const ids = matches.matches.map((m) => m.id);
    const rows = await all<{ id: string; namespace: string; content: string; metadata: string | null; created_at: string }>(
      env.DB,
      `SELECT id, namespace, content, metadata, created_at FROM memories
       WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
      userId,
      ...ids
    );
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const memories = [];
    for (const match of matches.matches) {
      const row = rowById.get(match.id);
      if (!row) continue;
      memories.push({
        memory_id: row.id,
        namespace: row.namespace,
        content: row.content,
        metadata: parseJson<Record<string, unknown> | null>(row.metadata, null),
        created_at: row.created_at,
        score: match.score,
      });
    }

    return { memories };
  } catch (error) {
    console.error("[recallMemories] Error:", error);
    if (error instanceof Error) {
      if (error.message.includes("Invalid OpenAI API key")) {
        return { error: "Your OpenAI API key is invalid. Please update it in Podgest settings." };
      }
      return { error: `Recall failed: ${error.message}` };
    }
    return { error: "Recall failed. Please try again." };
  }
}

async function listMemories(
  namespace: string | undefined,
  limit: number = 20,
  userId: string,
  env: Env
): Promise<{ memories: Array<{ memory_id: string; namespace: string; content: string; metadata: Record<string, unknown> | null; created_at: string }> }> {
  const cappedLimit = Math.min(Math.max(limit, 1), 100);

  const rows = namespace
    ? await all<{ id: string; namespace: string; content: string; metadata: string | null; created_at: string }>(
        env.DB,
        `SELECT id, namespace, content, metadata, created_at FROM memories
         WHERE user_id = ? AND namespace = ? ORDER BY created_at DESC LIMIT ?`,
        userId,
        namespace,
        cappedLimit
      )
    : await all<{ id: string; namespace: string; content: string; metadata: string | null; created_at: string }>(
        env.DB,
        `SELECT id, namespace, content, metadata, created_at FROM memories
         WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        userId,
        cappedLimit
      );

  return {
    memories: rows.map((r) => ({
      memory_id: r.id,
      namespace: r.namespace,
      content: r.content,
      metadata: parseJson<Record<string, unknown> | null>(r.metadata, null),
      created_at: r.created_at,
    })),
  };
}

async function forgetMemory(
  memoryId: string,
  userId: string,
  env: Env
): Promise<{ deleted: true; memory_id: string } | { error: string }> {
  // Verify the memory belongs to the requesting user before deleting
  const row = await one<{ id: string }>(
    env.DB,
    `SELECT id FROM memories WHERE id = ? AND user_id = ?`,
    memoryId,
    userId
  );

  if (!row) {
    return { error: "Memory not found" };
  }

  await run(env.DB, `DELETE FROM memories WHERE id = ? AND user_id = ?`, memoryId, userId);
  await env.VECTORIZE.deleteByIds([memoryId]);

  return { deleted: true, memory_id: memoryId };
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
            instructions: [
              "Podgest tracks the user's podcast subscriptions, transcripts, and daily digests.",
              "IMPORTANT: A subscription may be an AGGREGATOR feed (e.g. a ListenNotes playlist) that bundles episodes from many different shows into a single RSS feed. list_podcasts marks these with is_aggregator=true and lists the real shows inside (shows_included).",
              "Treat the shows inside an aggregator exactly like individual subscriptions: recent_episodes, search_podcasts, compare_takes, get_episode, and get_transcript all resolve and return the REAL show name (e.g. 'The Daily', 'Prof G Markets') automatically.",
              "Never tell the user they are 'only subscribed to' the aggregator, and never ask them to explain the aggregator - just use the underlying show names naturally.",
            ].join(" "),
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

          case "get_transcript":
            result = await getTranscript(toolArgs.episode_id as string, userId, env);
            break;

          case "get_digest_transcript":
            result = await getDigestTranscript(userId, env, toolArgs.date as string | undefined);
            break;

          case "save_memory":
            result = await saveMemory(
              toolArgs.content as string,
              toolArgs.namespace as string | undefined,
              toolArgs.metadata as Record<string, unknown> | undefined,
              userId,
              env
            );
            break;

          case "recall":
            result = await recallMemories(
              toolArgs.query as string,
              toolArgs.namespace as string | undefined,
              (toolArgs.limit as number | undefined) ?? 5,
              userId,
              env
            );
            break;

          case "list_memories":
            result = await listMemories(
              toolArgs.namespace as string | undefined,
              (toolArgs.limit as number | undefined) ?? 20,
              userId,
              env
            );
            break;

          case "forget":
            result = await forgetMemory(toolArgs.memory_id as string, userId, env);
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
    
    // Log the full context to debug
    console.log(`[mcpApiHandler] ctx type: ${typeof ctx}`);
    console.log(`[mcpApiHandler] ctx.props:`, JSON.stringify(typedCtx.props));
    
    const userId = typedCtx.props?.userId;
    console.log(`[mcpApiHandler] userId: ${userId}`);

    if (!userId) {
      console.error(`[mcpApiHandler] No userId in props`);
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

    // OAuth authorize - authenticate the user via the shared Better Auth session.
    // The Better Auth session cookie is set on .podgest.app (crossSubDomainCookies),
    // so we can verify it by forwarding cookies to the API's get-session endpoint.
    if (url.pathname === "/authorize") {
      const oauthReqInfo = await typedEnv.OAUTH_PROVIDER.parseAuthRequest(request);

      // Check for an existing Better Auth session
      const cookie = request.headers.get("Cookie") || "";
      let user: { id: string; email: string } | null = null;
      if (cookie) {
        try {
          const sessionResponse = await fetch("https://api.podgest.app/api/auth/get-session", {
            headers: { "Cookie": cookie },
          });
          if (sessionResponse.ok) {
            const data = await sessionResponse.json() as { user?: { id: string; email: string } } | null;
            if (data?.user?.id) user = data.user;
          }
        } catch {
          // fall through to login redirect
        }
      }

      if (user) {
        // Already signed in - complete the MCP OAuth grant immediately
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
        return Response.redirect(redirectTo, 302);
      }

      // No session - render a page that kicks off Google sign-in on the API's
      // Better Auth endpoint (must run in the browser so cookies get set),
      // returning to this /authorize URL (with its query intact) afterwards.
      return new Response(renderSignInPage(request.url), {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

// ============================================
// PAGE TEMPLATES
// ============================================

/**
 * Sign-in bootstrap page. Runs in the browser so the Better Auth state and
 * session cookies get set on the user's browser (they wouldn't if this worker
 * called the sign-in endpoint server-side). After Google sign-in completes,
 * Better Auth redirects back to the /authorize URL, which then finds a session.
 */
function renderSignInPage(returnUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Podgest - Sign in</title>
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
    <h1>Signing you in...</h1>
    <p class="status" id="status">Redirecting to Google.</p>
    <p class="error" id="error"></p>
  </div>
  <script>
    (async function() {
      try {
        const response = await fetch('https://api.podgest.app/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            provider: 'google',
            callbackURL: ${JSON.stringify(returnUrl)}
          })
        });

        if (!response.ok) {
          throw new Error('Could not start sign-in (HTTP ' + response.status + ')');
        }

        const data = await response.json();
        if (!data.url) throw new Error('No sign-in URL returned');
        window.location.href = data.url;
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

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function renderErrorPage(message: string): string {
  const safeMessage = escapeHtml(message);
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
  <div class="error">${safeMessage}</div>
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
