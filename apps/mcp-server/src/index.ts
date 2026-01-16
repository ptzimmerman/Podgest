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
  SUPABASE_ANON_KEY: string;
  SUPERMEMORY_API_KEY: string;
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
// AUTHENTICATION
// ============================================

interface SupabaseUser {
  id: string;
  email: string;
  user_metadata: {
    full_name?: string;
    name?: string;
  };
}

// Validate Supabase JWT token
async function validateJWT(token: string, env: Env): Promise<SupabaseUser | null> {
  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": env.SUPABASE_ANON_KEY,
      },
    });

    if (!response.ok) {
      return null;
    }

    return await response.json() as SupabaseUser;
  } catch {
    return null;
  }
}

// Validate API key from mcp_tokens table
async function validateAPIKey(apiKey: string, env: Env): Promise<string | null> {
  try {
    // API keys are stored as "pk_" + random string
    // We look up the token_hash (which is the full key for simplicity)
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/mcp_tokens?token_hash=eq.${encodeURIComponent(apiKey)}&select=user_id,expires_at`,
      {
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!response.ok) return null;

    const tokens = await response.json() as Array<{ user_id: string; expires_at: string | null }>;
    if (!tokens.length) return null;

    const token = tokens[0];
    
    // Check expiry
    if (token.expires_at && new Date(token.expires_at) < new Date()) {
      return null;
    }

    // Update last_used_at
    fetch(
      `${env.SUPABASE_URL}/rest/v1/mcp_tokens?token_hash=eq.${encodeURIComponent(apiKey)}`,
      {
        method: "PATCH",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      }
    ); // Fire and forget

    return token.user_id;
  } catch {
    return null;
  }
}

// Generate a new API key for a user
async function generateAPIKey(userId: string, email: string, env: Env): Promise<string> {
  const apiKey = `pk_${crypto.randomUUID().replace(/-/g, "")}`;
  
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/mcp_tokens`,
    {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        user_id: userId,
        token_hash: apiKey,
        name: `API Key for ${email}`,
        created_at: new Date().toISOString(),
      }),
    }
  );

  return apiKey;
}

// Authenticate request - supports both JWT and API key
async function authenticateRequest(request: Request, env: Env): Promise<{ userId: string } | { error: string }> {
  const authHeader = request.headers.get("Authorization");
  
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing Authorization header" };
  }

  const token = authHeader.slice(7);

  // Check if it's an API key (starts with pk_)
  if (token.startsWith("pk_")) {
    const userId = await validateAPIKey(token, env);
    if (userId) {
      return { userId };
    }
    return { error: "Invalid API key" };
  }

  // Otherwise treat as Supabase JWT
  const user = await validateJWT(token, env);
  if (user) {
    return { userId: user.id };
  }

  return { error: "Invalid token" };
}

// ============================================
// HTTP HANDLER
// ============================================

const MCP_SERVER_URL = "https://podgest-mcp.pztest.workers.dev";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "podgest-mcp",
        version: "2.0.0",
        auth_url: `${MCP_SERVER_URL}/auth`,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ========== AUTH PAGES ==========
    
    // Auth landing page - "Sign in with Google"
    if (url.pathname === "/auth" && request.method === "GET") {
      const redirectUri = `${MCP_SERVER_URL}/auth/callback`;
      const authUrl = `${env.SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`;
      
      return new Response(renderAuthPage(authUrl), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // OAuth callback - receives token, generates API key
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      // Supabase redirects with token in fragment, so we need JS to extract it
      return new Response(renderCallbackPage(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Token exchange - called by callback page JS
    if (url.pathname === "/auth/token" && request.method === "POST") {
      try {
        const { access_token } = await request.json() as { access_token: string };
        
        // Validate the Supabase JWT
        const user = await validateJWT(access_token, env);
        if (!user) {
          return new Response(JSON.stringify({ error: "Invalid token" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Generate API key for this user
        const apiKey = await generateAPIKey(user.id, user.email, env);

        return new Response(JSON.stringify({
          api_key: apiKey,
          user_id: user.id,
          email: user.email,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ========== MCP ENDPOINT ==========
    
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      // Authenticate request
      const auth = await authenticateRequest(request, env);
      
      if ("error" in auth) {
        return new Response(JSON.stringify({
          error: "auth_required",
          message: auth.error,
          auth_url: `${MCP_SERVER_URL}/auth`,
        }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const userId = auth.userId;

      // Handle SSE connection for streaming
      if (request.headers.get("Accept") === "text/event-stream") {
        return handleSSE(request, env, userId);
      }

      // Handle simple POST request
      if (request.method === "POST") {
        const mcpRequest = await request.json() as MCPRequest;
        const response = await handleMCPRequest(mcpRequest, env, userId);
        return new Response(JSON.stringify(response), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

// ============================================
// AUTH PAGE TEMPLATES
// ============================================

function renderAuthPage(authUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Podgest - Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #0f0f23 100%);
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 48px;
      max-width: 420px;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 32px;
      font-weight: 600;
      margin-bottom: 12px;
      background: linear-gradient(135deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: #94a3b8;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 14px 32px;
      font-size: 16px;
      font-weight: 500;
      color: #1f2937;
      background: #fff;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      text-decoration: none;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(255,255,255,0.15);
    }
    .btn svg { width: 20px; height: 20px; }
    .features {
      margin-top: 48px;
      text-align: left;
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 24px;
    }
    .features h3 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #64748b;
      margin-bottom: 16px;
    }
    .feature {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      color: #cbd5e1;
      font-size: 14px;
    }
    .feature span { font-size: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🎙️</div>
    <h1>Podgest</h1>
    <p>Sign in to connect your podcast intelligence to Claude, Cursor, and other AI tools.</p>
    
    <a href="${authUrl}" class="btn">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </a>

    <div class="features">
      <h3>What you'll get</h3>
      <div class="feature"><span>🔍</span> Search across all your podcast transcripts</div>
      <div class="feature"><span>📊</span> Compare perspectives from different shows</div>
      <div class="feature"><span>🎧</span> Daily AI-generated digest of your podcasts</div>
      <div class="feature"><span>🔐</span> Your data stays private and secure</div>
    </div>
  </div>
</body>
</html>`;
}

function renderCallbackPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Podgest - Authentication</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #0f0f23 100%);
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 48px;
      max-width: 560px;
    }
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
    .status { color: #94a3b8; margin-bottom: 32px; }
    
    .success { display: none; }
    .success h1 { color: #4ade80; }
    
    .saving { display: none; }
    .saving h1 { color: #60a5fa; }
    
    .done { display: none; }
    .done h1 { color: #4ade80; }
    
    .error { display: none; }
    .error h1 { color: #f87171; }
  </style>
</head>
<body>
  <div class="container">
    <div class="loading">
      <div class="spinner"></div>
      <h1>Authenticating...</h1>
      <p class="status">Please wait while we set up your account.</p>
    </div>
    
    <div class="saving">
      <div class="spinner"></div>
      <h1>Saving credentials...</h1>
      <p class="status">Storing your API key locally.</p>
    </div>
    
    <div class="done">
      <h1>✓ You're all set!</h1>
      <p class="status">Your API key has been saved. You can close this window and reload Cursor.</p>
      <p style="color: #64748b; font-size: 14px; margin-top: 24px;">
        API key saved to: <code style="color: #a78bfa;">~/.podgest/api_key</code>
      </p>
    </div>
    
    <div class="error">
      <h1>Authentication Failed</h1>
      <p class="status error-message">Something went wrong. Please try again.</p>
      <a href="/auth" style="color: #60a5fa;">← Back to sign in</a>
    </div>
  </div>

  <script>
    async function init() {
      // Extract token from URL fragment
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const accessToken = params.get('access_token');
      
      if (!accessToken) {
        showError('No access token received');
        return;
      }
      
      try {
        // Exchange for API key
        const response = await fetch('/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken })
        });
        
        if (!response.ok) {
          const data = await response.json();
          showError(data.error || 'Authentication failed');
          return;
        }
        
        const data = await response.json();
        
        // Now save the API key locally via localhost redirect
        document.querySelector('.loading').style.display = 'none';
        document.querySelector('.saving').style.display = 'block';
        
        // Redirect to localhost to save the key
        window.location.href = 'http://localhost:9876/save?key=' + encodeURIComponent(data.api_key);
        
      } catch (err) {
        showError('Network error: ' + err.message);
      }
    }
    
    function showError(message) {
      document.querySelector('.loading').style.display = 'none';
      document.querySelector('.error').style.display = 'block';
      document.querySelector('.error-message').textContent = message;
    }
    
    // Check if we're on the success page (redirected back from localhost)
    if (window.location.search.includes('success=true')) {
      document.querySelector('.loading').style.display = 'none';
      document.querySelector('.done').style.display = 'block';
    } else {
      init();
    }
  </script>
</body>
</html>`;
}

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
