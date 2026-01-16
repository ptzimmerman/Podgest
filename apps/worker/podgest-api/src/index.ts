import { Inngest } from "inngest";
import { serve } from "inngest/cloudflare";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INNGEST_EVENT_KEY: string;
  INNGEST_SIGNING_KEY: string;
  ANTHROPIC_API_KEY: string;
  SUPERMEMORY_API_KEY: string;
  ELEVENLABS_API_KEY: string;
}

// Voice ID for news broadcaster style
const VOICE_BROADCASTER = "cjVigY5qzO86Huf0OWal"; // Eric - Smooth, Trustworthy

// ============================================
// INNGEST CLIENT & FUNCTIONS
// ============================================

const inngest = new Inngest({ 
  id: "podgest",
  isDev: false,
});

const pollSubscriptions = inngest.createFunction(
  { id: "poll-subscriptions" },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    // This function is triggered by cron, but the actual work
    // happens via HTTP call to our /api/poll endpoint
    // (Inngest functions in Workers can't access env directly in the function body)
    return { message: "Use /api/poll endpoint to trigger polling" };
  }
);

// ============================================
// RSS PARSING
// ============================================

interface RSSEpisode {
  guid: string;
  title: string;
  description: string;
  audio_url: string;
  duration_seconds: number | null;
  published_at: string;
}

interface RSSFeed {
  title: string;
  artwork_url: string | null;
  episodes: RSSEpisode[];
}

async function parseRSSFeed(feedUrl: string): Promise<RSSFeed> {
  console.log(`[RSS] Fetching: ${feedUrl}`);
  
  const response = await fetch(feedUrl, {
    headers: { "User-Agent": "Podgest/1.0 (podcast aggregator)" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed: ${response.status}`);
  }

  const xml = await response.text();
  
  // Simple XML parsing without external deps
  const getTag = (text: string, tag: string): string => {
    const match = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return match ? match[1].trim() : "";
  };
  
  const getAttr = (text: string, tag: string, attr: string): string => {
    const match = text.match(new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["']`, 'i'));
    return match ? match[1] : "";
  };

  // Get channel info
  const channel = getTag(xml, "channel");
  const title = getTag(channel, "title").replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
  const artworkUrl = getAttr(channel, "itunes:image", "href") || getAttr(channel, "image", "href");

  // Parse episodes
  const episodes: RSSEpisode[] = [];
  const itemMatches = channel.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  
  for (const match of itemMatches) {
    const item = match[1];
    const audioUrl = getAttr(item, "enclosure", "url");
    
    if (!audioUrl) continue; // Skip items without audio
    
    // Get GUID - can be a tag or wrapped in CDATA
    let guid = getTag(item, "guid").replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
    if (!guid) guid = getTag(item, "link") || audioUrl;
    
    const episodeTitle = getTag(item, "title").replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
    const description = getTag(item, "description").replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').substring(0, 1000);
    const pubDate = getTag(item, "pubDate");
    const durationRaw = getTag(item, "itunes:duration");
    
    episodes.push({
      guid,
      title: episodeTitle || "Untitled",
      description,
      audio_url: audioUrl,
      duration_seconds: parseDuration(durationRaw),
      published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  console.log(`[RSS] Found ${episodes.length} episodes in "${title}"`);
  return { title, artwork_url: artworkUrl || null, episodes };
}

function parseDuration(duration: string): number | null {
  if (!duration) return null;
  
  // If it's just a number, return it
  if (/^\d+$/.test(duration)) return parseInt(duration);
  
  // Handle HH:MM:SS or MM:SS
  const parts = duration.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  
  return null;
}

// ============================================
// POLLING LOGIC
// ============================================

interface Subscription {
  id: string;
  user_id: string;
  feed_url: string;
  podcast_title: string;
}

async function pollAllSubscriptions(env: Env): Promise<{
  subscriptions_polled: number;
  new_episodes: number;
  transcriptions_triggered: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let newEpisodesTotal = 0;
  let transcriptionsTriggered = 0;

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Fetch all active subscriptions
  console.log("[Poll] Fetching subscriptions...");
  const subsResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?is_active=eq.true&select=id,user_id,feed_url,podcast_title`,
    { headers }
  );
  
  if (!subsResponse.ok) {
    throw new Error(`Failed to fetch subscriptions: ${subsResponse.status}`);
  }
  
  const subscriptions: Subscription[] = await subsResponse.json();
  console.log(`[Poll] Found ${subscriptions.length} active subscriptions`);

  // 2. Process each subscription
  for (const sub of subscriptions) {
    try {
      console.log(`[Poll] Processing: ${sub.podcast_title}`);
      
      // Parse RSS feed
      const feed = await parseRSSFeed(sub.feed_url);
      
      // Update subscription metadata
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${sub.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            artwork_url: feed.artwork_url,
            last_polled_at: new Date().toISOString(),
          }),
        }
      );

      // Get existing episode GUIDs for this feed
      const existingResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/episodes?feed_url=eq.${encodeURIComponent(sub.feed_url)}&select=guid`,
        { headers }
      );
      const existingEpisodes: { guid: string }[] = await existingResponse.json();
      const existingGuids = new Set(existingEpisodes.map(e => e.guid));
      
      // Find new episodes
      const newEpisodes = feed.episodes.filter(ep => !existingGuids.has(ep.guid));
      
      // Limit to 10 per poll (can run multiple polls to catch up)
      const episodesToProcess = newEpisodes.slice(0, 10);
      console.log(`[Poll] ${sub.podcast_title}: ${newEpisodes.length} new, processing ${episodesToProcess.length}`);

      // Insert new episodes and trigger transcription
      for (const episode of episodesToProcess) {
        // Insert episode
        const insertResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/episodes`,
          {
            method: "POST",
            headers: { ...headers, "Prefer": "return=representation" },
            body: JSON.stringify({
              feed_url: sub.feed_url,
              guid: episode.guid,
              title: episode.title,
              description: episode.description,
              audio_url: episode.audio_url,
              duration_seconds: episode.duration_seconds,
              published_at: episode.published_at,
            }),
          }
        );

        if (!insertResponse.ok) {
          const err = await insertResponse.text();
          console.error(`[Poll] Failed to insert episode: ${err}`);
          continue;
        }

        const [insertedEpisode] = await insertResponse.json();
        newEpisodesTotal++;
        console.log(`[Poll] Inserted episode: ${episode.title}`);

        // Create transcription record
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/transcriptions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              episode_id: insertedEpisode.id,
              status: "processing",
            }),
          }
        );

        // Trigger Modal transcription
        try {
          const modalResponse = await fetch(
            "https://ptzimmerman--podgest-transcribe-transcribe-web.modal.run",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                audio_url: episode.audio_url,
                webhook_url: "https://podgest-api.pztest.workers.dev/api/webhooks/modal",
                job_id: JSON.stringify({
                  episode_id: insertedEpisode.id,
                  transcription_id: insertedEpisode.id, // Will be updated
                }),
              }),
            }
          );

          if (modalResponse.ok) {
            transcriptionsTriggered++;
            console.log(`[Poll] Triggered transcription for: ${episode.title}`);
          } else {
            console.error(`[Poll] Modal trigger failed: ${modalResponse.status}`);
          }
        } catch (modalError) {
          console.error(`[Poll] Modal error:`, modalError);
          errors.push(`Modal error for ${episode.title}: ${modalError}`);
        }
      }
    } catch (subError) {
      const errorMsg = `Error processing ${sub.podcast_title}: ${subError}`;
      console.error(`[Poll] ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  return {
    subscriptions_polled: subscriptions.length,
    new_episodes: newEpisodesTotal,
    transcriptions_triggered: transcriptionsTriggered,
    errors,
  };
}

// ============================================
// WORKER FETCH HANDLER
// ============================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Manual poll trigger (for testing)
    if (url.pathname === "/api/poll" && request.method === "POST") {
      try {
        const result = await pollAllSubscriptions(env);
        return json(result);
      } catch (error) {
        console.error("[Poll] Error:", error);
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    // Inngest endpoint
    if (url.pathname === "/api/inngest") {
      try {
        const handler = serve({
          client: inngest,
          functions: [pollSubscriptions],
          signingKey: env.INNGEST_SIGNING_KEY,
        });
        return await handler(request, env, ctx);
      } catch (error) {
        console.error("[Inngest] Error:", error);
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    // Modal webhook
    if (url.pathname === "/api/webhooks/modal" && request.method === "POST") {
      return handleModalWebhook(request, env, ctx);
    }
    
    // Manual topic extraction trigger (for testing)
    if (url.pathname === "/api/extract-topics" && request.method === "POST") {
      return handleExtractTopics(request, env);
    }
    
    // Manual SuperMemory embedding trigger (for testing)
    if (url.pathname === "/api/embed-content" && request.method === "POST") {
      return handleEmbedContent(request, env);
    }
    
    // Generate digest (for testing)
    if (url.pathname === "/api/generate-digest" && request.method === "POST") {
      return handleGenerateDigest(request, env);
    }
    
    // RSS feed for Spotify
    if (url.pathname.startsWith("/feed/") && request.method === "GET") {
      const userId = url.pathname.replace("/feed/", "").replace(".xml", "");
      return handleRSSFeed(userId, env);
    }

    return json({ error: "Not found" }, 404);
  },
};

// ============================================
// HELPERS
// ============================================

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleModalWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const payload = await request.json() as {
      status: string;
      job_id: string;
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
      language?: string;
      duration?: number;
      error?: string;
    };

    console.log(`[Webhook] Received: status=${payload.status}, job_id=${payload.job_id}`);

    let jobData: { episode_id: string };
    try {
      jobData = JSON.parse(payload.job_id);
    } catch {
      return json({ error: "Invalid job_id" }, 400);
    }

    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    };

    if (payload.status === "completed" && payload.text) {
      // Upload transcript to storage
      const transcriptPath = `${jobData.episode_id}/transcript.json`;
      const storageResult = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/transcripts/${transcriptPath}`,
        {
          method: "POST",
          headers: { ...headers, "x-upsert": "true" },
          body: JSON.stringify({
            text: payload.text,
            segments: payload.segments,
            language: payload.language,
            duration: payload.duration,
          }),
        }
      );
      console.log(`[Webhook] Storage upload: ${storageResult.status}`);

      // Update transcription record
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            status: "completed",
            transcript_storage_path: transcriptPath,
            word_count: payload.text.split(/\s+/).length,
            language: payload.language || "en",
            completed_at: new Date().toISOString(),
          }),
        }
      );

      console.log(`[Webhook] Transcription completed for episode: ${jobData.episode_id}`);
      
      // Trigger topic extraction and SuperMemory embedding asynchronously (don't wait)
      ctx.waitUntil(
        extractTopicsForEpisode(jobData.episode_id, payload.text, env)
          .then(() => embedInSuperMemory(jobData.episode_id, payload.text, env))
      );
      
      return json({ success: true, status: "completed" });
    } else {
      // Update as failed
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ status: "failed", error_message: payload.error }),
        }
      );

      console.log(`[Webhook] Transcription failed for episode: ${jobData.episode_id}`);
      return json({ success: true, status: "failed" });
    }
  } catch (error) {
    console.error("[Webhook] Error:", error);
    return json({ error: "Internal error" }, 500);
  }
}

// ============================================
// TOPIC EXTRACTION (Claude)
// ============================================

interface TopicExtractionResult {
  topics: string[];
  themes: string[];
  summary: string;
  key_points: string[];
  sentiment: "positive" | "negative" | "neutral" | "mixed";
}

async function extractTopicsForEpisode(episodeId: string, transcriptText: string, env: Env): Promise<void> {
  console.log(`[Topics] Starting extraction for episode: ${episodeId}`);
  
  try {
    const result = await callClaudeForTopics(transcriptText, env.ANTHROPIC_API_KEY);
    
    // Get transcription ID
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    const transcriptionResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${episodeId}&select=id`,
      { headers }
    );
    const transcriptions = await transcriptionResponse.json() as { id: string }[];
    
    if (!transcriptions.length) {
      console.error(`[Topics] No transcription found for episode: ${episodeId}`);
      return;
    }
    
    const transcriptionId = transcriptions[0].id;
    
    // Insert topic extraction
    const insertResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/topic_extractions`,
      {
        method: "POST",
        headers: { ...headers, "Prefer": "return=minimal" },
        body: JSON.stringify({
          transcription_id: transcriptionId,
          topics: result,
        }),
      }
    );
    
    if (!insertResponse.ok) {
      const err = await insertResponse.text();
      console.error(`[Topics] Failed to insert: ${err}`);
      return;
    }
    
    console.log(`[Topics] Extraction complete for episode: ${episodeId}`);
    console.log(`[Topics] Found ${result.topics.length} topics, ${result.themes.length} themes`);
    
  } catch (error) {
    console.error(`[Topics] Error for episode ${episodeId}:`, error);
  }
}

async function callClaudeForTopics(transcriptText: string, apiKey: string): Promise<TopicExtractionResult> {
  // Truncate if too long (Claude has ~200k context, but we'll be conservative)
  const maxChars = 100000;
  const text = transcriptText.length > maxChars 
    ? transcriptText.substring(0, maxChars) + "\n\n[Transcript truncated...]"
    : transcriptText;
  
  const systemPrompt = `You are an expert at analyzing podcast transcripts. Extract structured information from the transcript provided.

Return a JSON object with exactly this structure:
{
  "topics": ["topic1", "topic2", ...],  // Main topics discussed (5-10 items)
  "themes": ["theme1", "theme2", ...],  // Broader themes (3-5 items)
  "summary": "A 2-3 sentence summary of the episode",
  "key_points": ["point1", "point2", ...],  // Key takeaways (3-7 items)
  "sentiment": "positive" | "negative" | "neutral" | "mixed"
}

Be specific with topics (e.g., "Federal Reserve interest rate policy" not just "economics").
Keep the summary concise but informative.
IMPORTANT: Return ONLY the raw JSON object. Do NOT wrap it in markdown code fences. Do NOT include any text before or after the JSON.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Analyze this podcast transcript and extract topics:\n\n${text}`,
        },
      ],
      system: systemPrompt,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${err}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };
  
  const textContent = data.content.find(c => c.type === "text");
  if (!textContent) {
    throw new Error("No text content in Claude response");
  }
  
  // Parse the JSON response - strip markdown code fences if present
  try {
    let jsonText = textContent.text.trim();
    
    // Remove markdown code fences if present
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.slice(7);
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.slice(3);
    }
    if (jsonText.endsWith("```")) {
      jsonText = jsonText.slice(0, -3);
    }
    jsonText = jsonText.trim();
    
    console.log("[Topics] Parsing JSON:", jsonText.substring(0, 200) + "...");
    return JSON.parse(jsonText) as TopicExtractionResult;
  } catch (parseError) {
    console.error("[Topics] Failed to parse Claude response:", textContent.text.substring(0, 500));
    console.error("[Topics] Parse error:", parseError);
    // Return a fallback structure
    return {
      topics: ["Unable to extract topics"],
      themes: ["Unknown"],
      summary: "Topic extraction failed - raw response stored",
      key_points: [],
      sentiment: "neutral",
    };
  }
}

// ============================================
// SUPERMEMORY EMBEDDING
// ============================================

async function embedInSuperMemory(episodeId: string, transcriptText: string, env: Env): Promise<void> {
  console.log(`[SuperMemory] Starting embedding for episode: ${episodeId}`);
  
  try {
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Get episode metadata
    const episodeResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${episodeId}&select=id,title,published_at,feed_url`,
      { headers }
    );
    
    if (!episodeResponse.ok) {
      console.error(`[SuperMemory] Failed to fetch episode: ${episodeResponse.status}`);
      return;
    }
    
    const episodes = await episodeResponse.json() as Array<{
      id: string;
      title: string;
      published_at: string;
      feed_url: string;
    }>;
    
    if (!episodes.length) {
      console.error(`[SuperMemory] Episode not found: ${episodeId}`);
      return;
    }
    
    const episode = episodes[0];
    
    // Get subscription info via feed_url
    const subResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?feed_url=eq.${encodeURIComponent(episode.feed_url)}&select=user_id,podcast_title&limit=1`,
      { headers }
    );
    const subs = await subResponse.json() as Array<{ user_id: string; podcast_title: string }>;
    
    const userId = subs[0]?.user_id || "unknown";
    const podcastTitle = subs[0]?.podcast_title || "Unknown Podcast";
    
    // Get transcription ID first
    const transcriptionResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${episodeId}&select=id`,
      { headers }
    );
    const transcriptions = await transcriptionResponse.json() as Array<{ id: string }>;
    const transcriptionId = transcriptions[0]?.id;
    
    // Get topic extraction if available
    let topics: TopicExtractionResult | undefined;
    if (transcriptionId) {
      const topicsResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/topic_extractions?transcription_id=eq.${transcriptionId}&select=topics`,
        { headers }
      );
      const topicExtractions = await topicsResponse.json() as Array<{ topics: TopicExtractionResult }>;
      topics = topicExtractions[0]?.topics;
    }
    
    // Send to SuperMemory
    const superMemoryResponse = await fetch("https://api.supermemory.ai/v3/documents", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.SUPERMEMORY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: transcriptText,
        metadata: {
          episode_id: episodeId,
          episode_title: episode.title,
          podcast_title: podcastTitle,
          published_at: new Date(episode.published_at).getTime(),
          topics: topics?.topics || [],
          themes: topics?.themes || [],
          summary: topics?.summary || "",
        },
        containerTags: [userId], // Multi-tenant isolation
      }),
    });
    
    if (!superMemoryResponse.ok) {
      const err = await superMemoryResponse.text();
      console.error(`[SuperMemory] API error: ${superMemoryResponse.status} - ${err}`);
      return;
    }
    
    const result = await superMemoryResponse.json() as { id: string; status: string };
    console.log(`[SuperMemory] Embedded episode ${episodeId} as doc ${result.id}`);
    
    // Update transcription with SuperMemory doc ID
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${episodeId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ supermemory_doc_id: result.id }),
      }
    );
    
    console.log(`[SuperMemory] Embedding complete for episode: ${episodeId}`);
    
  } catch (error) {
    console.error(`[SuperMemory] Error for episode ${episodeId}:`, error);
  }
}

async function handleEmbedContent(request: Request, env: Env): Promise<Response> {
  try {
    const { episode_id } = await request.json() as { episode_id: string };
    
    if (!episode_id) {
      return json({ error: "episode_id required" }, 400);
    }
    
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Get transcript
    const transcriptResponse = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/transcripts/${episode_id}/transcript.json`,
      { headers }
    );
    
    if (!transcriptResponse.ok) {
      return json({ error: "Transcript not found" }, 404);
    }
    
    const transcript = await transcriptResponse.json() as { text: string };
    
    await embedInSuperMemory(episode_id, transcript.text, env);
    
    return json({ success: true, episode_id });
    
  } catch (error) {
    console.error("[EmbedContent] Error:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handleExtractTopics(request: Request, env: Env): Promise<Response> {
  try {
    const { episode_id } = await request.json() as { episode_id: string };
    
    if (!episode_id) {
      return json({ error: "episode_id required" }, 400);
    }
    
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Get transcript from storage
    const transcriptResponse = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/transcripts/${episode_id}/transcript.json`,
      { headers }
    );
    
    if (!transcriptResponse.ok) {
      return json({ error: "Transcript not found" }, 404);
    }
    
    const transcript = await transcriptResponse.json() as { text: string };
    
    // Extract topics
    const result = await callClaudeForTopics(transcript.text, env.ANTHROPIC_API_KEY);
    
    // Get transcription ID
    const transcriptionResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${episode_id}&select=id`,
      { headers }
    );
    const transcriptions = await transcriptionResponse.json() as { id: string }[];
    
    if (!transcriptions.length) {
      return json({ error: "Transcription record not found" }, 404);
    }
    
    // Insert or update topic extraction
    const insertResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/topic_extractions`,
      {
        method: "POST",
        headers: { ...headers, "Prefer": "return=representation" },
        body: JSON.stringify({
          transcription_id: transcriptions[0].id,
          topics: result,
        }),
      }
    );
    
    if (!insertResponse.ok) {
      const err = await insertResponse.text();
      return json({ error: `Failed to save: ${err}` }, 500);
    }
    
    return json({
      success: true,
      episode_id,
      extraction: result,
    });
    
  } catch (error) {
    console.error("[ExtractTopics] Error:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ============================================
// DIGEST GENERATION
// ============================================

interface DigestScript {
  title: string;
  script: string;  // Single narrator script
  topics_covered: string[];
  word_count: number;
}

async function handleGenerateDigest(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { 
      user_id?: string; 
      hours_back?: number;
      max_length_minutes?: number;
    };
    
    const hoursBack = body.hours_back || 24;
    const maxLengthMinutes = body.max_length_minutes || 30;
    
    console.log(`[Digest] Generating digest for last ${hoursBack} hours, max ${maxLengthMinutes} min`);
    
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // 1. Fetch recent episodes with their topic extractions
    const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    
    const episodesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?created_at=gte.${cutoffDate}&select=id,title,description,published_at`,
      { headers }
    );
    
    if (!episodesResponse.ok) {
      return json({ error: "Failed to fetch episodes" }, 500);
    }
    
    const episodes = await episodesResponse.json() as Array<{
      id: string;
      title: string;
      description: string;
      published_at: string;
    }>;
    
    if (!episodes.length) {
      return json({ error: "No recent episodes found", hours_back: hoursBack }, 404);
    }
    
    console.log(`[Digest] Found ${episodes.length} episodes`);
    
    // 2. Get topic extractions for these episodes
    const episodeIds = episodes.map(e => e.id);
    const topicsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=in.(${episodeIds.join(",")})&select=episode_id,id`,
      { headers }
    );
    const transcriptions = await topicsResponse.json() as Array<{ episode_id: string; id: string }>;
    
    const transcriptionIds = transcriptions.map(t => t.id);
    const extractionsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/topic_extractions?transcription_id=in.(${transcriptionIds.join(",")})&select=transcription_id,topics`,
      { headers }
    );
    const extractions = await extractionsResponse.json() as Array<{ 
      transcription_id: string; 
      topics: TopicExtractionResult;
    }>;
    
    // Map extractions to episodes
    const transcriptionToEpisode = new Map(transcriptions.map(t => [t.id, t.episode_id]));
    const episodeTopics = new Map<string, TopicExtractionResult>();
    for (const ext of extractions) {
      const episodeId = transcriptionToEpisode.get(ext.transcription_id);
      if (episodeId) {
        episodeTopics.set(episodeId, ext.topics);
      }
    }
    
    // 3. Build context for Claude
    const episodeSummaries = episodes.map(ep => {
      const topics = episodeTopics.get(ep.id);
      return {
        title: ep.title,
        summary: topics?.summary || ep.description?.substring(0, 200) || "No summary available",
        topics: topics?.topics || [],
        themes: topics?.themes || [],
        key_points: topics?.key_points || [],
      };
    });
    
    console.log(`[Digest] Generating script with Claude...`);
    
    // 4. Generate news broadcaster script with Claude
    const script = await generateDigestScript(episodeSummaries, maxLengthMinutes, env.ANTHROPIC_API_KEY);
    
    console.log(`[Digest] Script generated: ${script.word_count} words`);
    
    // 5. Generate single audio file with ElevenLabs
    console.log(`[Digest] Generating audio with ElevenLabs (${script.script.length} chars)...`);
    
    const audioBase64 = await generateSpeech(script.script, VOICE_BROADCASTER, env.ELEVENLABS_API_KEY);
    
    if (!audioBase64) {
      return json({ 
        error: "Failed to generate audio",
        script: script, // Return script so user can manually use it
      }, 500);
    }
    
    console.log(`[Digest] Audio generated successfully`);
    
    // 6. Upload to Supabase Storage
    const digestId = crypto.randomUUID();
    const audioPath = `${digestId}/digest.mp3`;
    
    const uploadResponse = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/digests/${audioPath}`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "audio/mpeg",
          "x-upsert": "true",
        },
        body: Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0)),
      }
    );
    
    if (!uploadResponse.ok) {
      const err = await uploadResponse.text();
      console.error(`[Digest] Upload failed: ${err}`);
      return json({ error: "Failed to upload audio", details: err }, 500);
    }
    
    // Get public URL
    const audioUrl = `${env.SUPABASE_URL}/storage/v1/object/public/digests/${audioPath}`;
    const durationSeconds = Math.round(script.word_count / 2.5); // ~150 words/min
    
    console.log(`[Digest] Uploaded to: ${audioUrl}`);
    
    // 7. Save digest record to database
    // Note: For now, use a placeholder user_id since we don't have auth yet
    const placeholderUserId = body.user_id || "00000000-0000-0000-0000-000000000000";
    
    const digestRecord = {
      id: digestId,
      user_id: placeholderUserId,
      digest_date: new Date().toISOString().split('T')[0],
      status: "completed",
      topic_clusters: { topics: script.topics_covered, title: script.title },
      audio_storage_path: audioPath,
      audio_url: audioUrl,
      duration_seconds: durationSeconds,
      episodes_included: episodeIds,
      completed_at: new Date().toISOString(),
    };
    
    const insertDigestResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests`,
      {
        method: "POST",
        headers: { ...headers, "Prefer": "return=minimal" },
        body: JSON.stringify(digestRecord),
      }
    );
    
    if (!insertDigestResponse.ok) {
      console.error(`[Digest] Failed to save record: ${await insertDigestResponse.text()}`);
      // Still return success since audio was generated
    }
    
    return json({
      success: true,
      digest_id: digestId,
      episodes_count: episodes.length,
      script: {
        title: script.title,
        word_count: script.word_count,
        topics_covered: script.topics_covered,
        preview: script.script.substring(0, 500) + "...",
      },
      audio: {
        url: audioUrl,
        characters: script.script.length,
        duration_seconds: durationSeconds,
      },
    });
    
  } catch (error) {
    console.error("[Digest] Error:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function generateDigestScript(
  episodes: Array<{
    title: string;
    summary: string;
    topics: string[];
    themes: string[];
    key_points: string[];
  }>,
  maxMinutes: number,
  apiKey: string
): Promise<DigestScript> {
  
  // ~150 words per minute for natural speech
  const targetWordCount = maxMinutes * 150;
  
  const systemPrompt = `You are a professional news broadcaster writing a podcast script.
Write in a clear, engaging news anchor style - authoritative but approachable.

Guidelines:
- Start with a brief intro ("Good morning, I'm your host for today's digest...")
- Cover the most important and interesting stories first
- Group related topics together with smooth transitions
- Use clear, concise language suitable for audio
- Include brief analysis and context, not just facts
- Aim for approximately ${targetWordCount} words (${maxMinutes} minutes at natural pace)
- End with a brief sign-off

Return a JSON object with this structure:
{
  "title": "Daily Digest - [Date or main theme]",
  "script": "Good morning, I'm your host... [full script as single string]",
  "topics_covered": ["topic1", "topic2", ...],
  "word_count": 450
}

IMPORTANT: Return ONLY the JSON object, no markdown formatting.
The "script" field should be the complete script as a single string with natural paragraph breaks.`;

  const episodeContext = episodes.map((ep, i) => 
    `Story ${i + 1}: "${ep.title}"
Summary: ${ep.summary}
Key Points: ${ep.key_points.join("; ")}
Topics: ${ep.topics.join(", ")}`
  ).join("\n\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Create a ${maxMinutes}-minute news-style podcast script covering these ${episodes.length} stories:\n\n${episodeContext}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${err}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };
  
  const textContent = data.content.find(c => c.type === "text");
  if (!textContent) {
    throw new Error("No text content in Claude response");
  }
  
  // Parse JSON, stripping markdown if present
  let jsonText = textContent.text.trim();
  if (jsonText.startsWith("```json")) jsonText = jsonText.slice(7);
  else if (jsonText.startsWith("```")) jsonText = jsonText.slice(3);
  if (jsonText.endsWith("```")) jsonText = jsonText.slice(0, -3);
  jsonText = jsonText.trim();
  
  const result = JSON.parse(jsonText) as DigestScript;
  
  // Ensure word_count is set
  if (!result.word_count) {
    result.word_count = result.script.split(/\s+/).length;
  }
  
  return result;
}

// ============================================
// RSS FEED FOR SPOTIFY
// ============================================

async function handleRSSFeed(userId: string, env: Env): Promise<Response> {
  try {
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Fetch completed digests for this user
    const digestsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&status=eq.completed&order=digest_date.desc&limit=50`,
      { headers }
    );
    
    if (!digestsResponse.ok) {
      return new Response("Failed to fetch digests", { status: 500 });
    }
    
    const digests = await digestsResponse.json() as Array<{
      id: string;
      digest_date: string;
      topic_clusters: { topics: string[]; title: string };
      audio_url: string;
      duration_seconds: number;
      completed_at: string;
    }>;
    
    // Build RSS XML
    const feedUrl = `https://podgest-api.pztest.workers.dev/feed/${userId}`;
    const now = new Date().toUTCString();
    
    // Build items with actual file sizes
    const items: string[] = [];
    for (const d of digests) {
      const pubDate = new Date(d.completed_at).toUTCString();
      const title = d.topic_clusters?.title || `Daily Digest - ${d.digest_date}`;
      const description = d.topic_clusters?.topics?.join(", ") || "Your daily podcast digest";
      const duration = formatDuration(d.duration_seconds || 0);
      
      // Get actual file size from audio URL
      let fileSize = 0;
      try {
        const headResponse = await fetch(d.audio_url, { method: "HEAD" });
        const contentLength = headResponse.headers.get("content-length");
        if (contentLength) {
          fileSize = parseInt(contentLength, 10);
        }
      } catch (e) {
        console.error(`[RSS] Failed to get file size for ${d.id}`);
      }
      
      items.push(`
    <item>
      <title><![CDATA[${title}]]></title>
      <description><![CDATA[Topics covered: ${description}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${d.id}</guid>
      <enclosure url="${d.audio_url}" length="${fileSize}" type="audio/mpeg"/>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
      <itunes:episodeType>Full</itunes:episodeType>
    </item>`);
    }
    
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Podgest Daily Digest</title>
    <description>Your personalized podcast news digest, delivered daily. AI-powered summaries of your favorite podcasts.</description>
    <link>${feedUrl}</link>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <itunes:author>Podgest</itunes:author>
    <itunes:summary>AI-powered daily digest of your favorite podcasts.</itunes:summary>
    <itunes:category text="News">
      <itunes:category text="Daily News"/>
    </itunes:category>
    <itunes:explicit>no</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <itunes:owner>
      <itunes:name>Podgest</itunes:name>
      <itunes:email>podgest@example.com</itunes:email>
    </itunes:owner>
    <itunes:image href="https://xpviiukiavtpsnafpdmy.supabase.co/storage/v1/object/public/digests/podcast-cover.png"/>
    <image>
      <url>https://xpviiukiavtpsnafpdmy.supabase.co/storage/v1/object/public/digests/podcast-cover.png</url>
      <title>Podgest Daily Digest</title>
      <link>${feedUrl}</link>
    </image>
${items.join("\n")}
  </channel>
</rss>`;

    return new Response(rss, {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
    
  } catch (error) {
    console.error("[RSS] Error:", error);
    return new Response("Internal error", { status: 500 });
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function generateSpeech(text: string, voiceId: string, apiKey: string): Promise<string | null> {
  try {
    console.log(`[TTS] Generating speech for ${text.length} chars with voice ${voiceId}`);
    
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    console.log(`[TTS] Response status: ${response.status}`);

    if (!response.ok) {
      const err = await response.text();
      console.error(`[TTS] API Error: ${response.status} - ${err}`);
      return null;
    }

    // Get array buffer
    const arrayBuffer = await response.arrayBuffer();
    console.log(`[TTS] Received ${arrayBuffer.byteLength} bytes`);
    
    // Convert to base64 in chunks to avoid stack overflow
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.slice(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    const base64 = btoa(binary);
    
    console.log(`[TTS] Converted to base64: ${base64.length} chars`);
    return base64;
    
  } catch (error) {
    console.error("[TTS] Exception:", error);
    return null;
  }
}
