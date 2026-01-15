import { Inngest } from "inngest";
import { serve } from "inngest/cloudflare";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INNGEST_EVENT_KEY: string;
  INNGEST_SIGNING_KEY: string;
}

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
      
      // Limit to 3 per poll to avoid overwhelming Modal
      const episodesToProcess = newEpisodes.slice(0, 3);
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
      return handleModalWebhook(request, env);
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

async function handleModalWebhook(request: Request, env: Env): Promise<Response> {
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
            transcript_text: payload.text.substring(0, 10000),
            completed_at: new Date().toISOString(),
          }),
        }
      );

      console.log(`[Webhook] Transcription completed for episode: ${jobData.episode_id}`);
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
