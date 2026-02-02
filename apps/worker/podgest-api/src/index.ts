import { getUserApiKeys, validateOpenAIKey, validateAnthropicKey, validateElevenLabsKey } from './user-keys';
import { generateChunkedEmbeddings } from './embeddings';
import { encryptApiKey } from './encryption';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  SUPERMEMORY_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  OPENAI_API_KEY: string;
  // Phase 8: BYOK encryption key for user API keys
  // Generate with: openssl rand -hex 32
  API_KEY_ENCRYPTION_KEY: string;
}
// Note: Inngest removed - now using Supabase pg_cron for scheduling

// Voice ID for news broadcaster style
const VOICE_BROADCASTER = "cjVigY5qzO86Huf0OWal"; // Eric - Smooth, Trustworthy

// Content exclusion list - these sources/people are permanently excluded from digests
const EXCLUDED_CONTENT_CREATORS = [
  "peter zeihan",
  "zeihan",
];

function shouldExcludeEpisode(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return EXCLUDED_CONTENT_CREATORS.some(name => text.includes(name.toLowerCase()));
}

// Extract original podcast name from ListenNotes description HTML
// Format: <strong>Podcast</strong>: <a href="...">Freakonomics Radio</a>
function extractOriginalPodcastName(description: string): string | null {
  // Try ListenNotes format first
  const listenNotesMatch = description.match(/<strong>Podcast<\/strong>:\s*<a[^>]*>([^<]+)<\/a>/i);
  if (listenNotesMatch) {
    return listenNotesMatch[1].trim();
  }
  return null;
}

// Extract original podcast RSS URL from ListenNotes description
// Format: <strong>Podcast</strong>: <a href="https://www.listennotes.com/podcasts/...">
function extractOriginalPodcastUrl(description: string): string | null {
  const match = description.match(/<strong>Podcast<\/strong>:\s*<a\s+href="([^"]+)"/i);
  if (match) {
    return match[1];
  }
  return null;
}

// Extract original episode URL from ListenNotes description
// Format: <strong>Episode</strong>: <a href="https://www.listennotes.com/e/EPISODE_ID/">
function extractOriginalEpisodeId(description: string): string | null {
  const match = description.match(/<strong>Episode<\/strong>:\s*<a\s+href="https:\/\/www\.listennotes\.com\/e\/([^\/]+)\//i);
  if (match) {
    return match[1];
  }
  return null;
}

// Fetch original RSS feed URL from a ListenNotes podcast page
async function fetchOriginalRssUrl(listenNotesPodcastUrl: string): Promise<string | null> {
  try {
    // ListenNotes podcast pages have RSS feed links
    // We need to scrape the page or use their pattern
    // The RSS link is usually in the page source
    const response = await fetch(listenNotesPodcastUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    
    if (!response.ok) return null;
    
    const html = await response.text();
    
    // Look for RSS feed link patterns
    // ListenNotes pages often have: <a href="https://feeds.simplecast.com/..." ... >RSS</a>
    const rssMatch = html.match(/href="(https:\/\/feeds\.[^"]+)"/i) ||
                     html.match(/href="(https:\/\/[^"]+\/feed[^"]*\.xml)"/i) ||
                     html.match(/href="(https:\/\/[^"]+\/rss[^"]*)"/i);
    
    if (rssMatch) {
      return rssMatch[1];
    }
    
    return null;
  } catch (error) {
    console.error(`[Transcript] Failed to fetch original RSS URL:`, error);
    return null;
  }
}

// Check for podcast:transcript in RSS feed and return transcript URL if found
interface TranscriptInfo {
  url: string;
  type: string; // text/plain, text/html, application/json, text/vtt, application/srt
}

async function findTranscriptInRss(
  rssUrl: string,
  episodeGuid: string,
  episodeTitle: string
): Promise<TranscriptInfo | null> {
  try {
    console.log(`[Transcript] Checking RSS for transcript: ${rssUrl}`);
    
    const response = await fetch(rssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    
    if (!response.ok) {
      console.log(`[Transcript] RSS fetch failed: ${response.status}`);
      return null;
    }
    
    const xml = await response.text();
    
    // Find the episode by matching GUID or title
    // Episodes are in <item> tags
    const items = xml.split(/<item[^>]*>/i).slice(1);
    
    for (const item of items) {
      // Check if this is the right episode
      const guidMatch = item.match(/<guid[^>]*>([^<]+)<\/guid>/i);
      const titleMatch = item.match(/<title>([^<]+)<\/title>/i) ||
                         item.match(/<itunes:title>([^<]+)<\/itunes:title>/i);
      
      const itemGuid = guidMatch?.[1]?.trim();
      const itemTitle = titleMatch?.[1]?.trim();
      
      // Match by GUID (preferred) or by title similarity
      const guidMatches = itemGuid && (
        itemGuid === episodeGuid ||
        itemGuid.includes(episodeGuid) ||
        episodeGuid.includes(itemGuid)
      );
      
      const titleMatches = itemTitle && (
        itemTitle.toLowerCase().includes(episodeTitle.toLowerCase().substring(0, 30)) ||
        episodeTitle.toLowerCase().includes(itemTitle.toLowerCase().substring(0, 30))
      );
      
      if (guidMatches || titleMatches) {
        // Found the episode! Check for transcript
        // Podcasting 2.0 format: <podcast:transcript url="..." type="..."/>
        const transcriptMatch = item.match(
          /<podcast:transcript[^>]+url="([^"]+)"[^>]*type="([^"]+)"/i
        ) || item.match(
          /<podcast:transcript[^>]+type="([^"]+)"[^>]*url="([^"]+)"/i
        );
        
        if (transcriptMatch) {
          // Handle both attribute orderings
          const url = transcriptMatch[1].startsWith('http') ? transcriptMatch[1] : transcriptMatch[2];
          const type = transcriptMatch[1].startsWith('http') ? transcriptMatch[2] : transcriptMatch[1];
          
          console.log(`[Transcript] Found transcript: ${url} (${type})`);
          return { url, type };
        }
        
        // Also check for alternative transcript formats
        const altTranscriptMatch = item.match(/<transcript[^>]+url="([^"]+)"/i);
        if (altTranscriptMatch) {
          console.log(`[Transcript] Found alt transcript: ${altTranscriptMatch[1]}`);
          return { url: altTranscriptMatch[1], type: "text/plain" };
        }
        
        console.log(`[Transcript] Episode found but no transcript tag`);
        return null;
      }
    }
    
    console.log(`[Transcript] Episode not found in RSS`);
    return null;
  } catch (error) {
    console.error(`[Transcript] Error checking RSS:`, error);
    return null;
  }
}

// Download and parse transcript from URL
async function downloadTranscript(transcriptInfo: TranscriptInfo): Promise<string | null> {
  try {
    console.log(`[Transcript] Downloading: ${transcriptInfo.url}`);
    
    const response = await fetch(transcriptInfo.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    
    if (!response.ok) {
      console.error(`[Transcript] Download failed: ${response.status}`);
      return null;
    }
    
    const content = await response.text();
    
    // Parse based on type
    switch (transcriptInfo.type) {
      case "text/plain":
        return content;
        
      case "text/html":
        // Strip HTML tags
        return content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        
      case "application/json":
        // Try to extract text from JSON (various formats)
        try {
          const json = JSON.parse(content);
          // Common formats: { text: "..." }, { transcript: "..." }, { segments: [...] }
          if (typeof json.text === "string") return json.text;
          if (typeof json.transcript === "string") return json.transcript;
          if (Array.isArray(json.segments)) {
            return json.segments.map((s: { text?: string }) => s.text || "").join(" ");
          }
          if (Array.isArray(json)) {
            return json.map((s: { text?: string }) => s.text || "").join(" ");
          }
        } catch {
          return content;
        }
        return null;
        
      case "text/vtt":
      case "application/x-subrip":
      case "application/srt":
        // Parse VTT/SRT - extract just the text lines
        const lines = content.split("\n");
        const textLines: string[] = [];
        for (const line of lines) {
          // Skip timestamps, cue identifiers, WEBVTT header
          if (line.match(/^\d+$/) ||                    // Cue number
              line.match(/-->/) ||                      // Timestamp
              line.match(/^WEBVTT/i) ||                // VTT header
              line.match(/^NOTE/i) ||                  // VTT comment
              line.trim() === "") {
            continue;
          }
          textLines.push(line.trim());
        }
        return textLines.join(" ");
        
      default:
        // Try as plain text
        return content;
    }
  } catch (error) {
    console.error(`[Transcript] Download error:`, error);
    return null;
  }
}

// Cache for original RSS URLs (podcast URL -> RSS URL)
const rssUrlCache = new Map<string, string | null>();

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

async function pollAllSubscriptions(env: Env, logger?: PipelineLogger): Promise<{
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
    const errorMsg = `Failed to fetch subscriptions: ${subsResponse.status}`;
    await logger?.log('poll_fetch_subscriptions', 'failed', {}, errorMsg);
    throw new Error(errorMsg);
  }
  
  const subscriptions: Subscription[] = await subsResponse.json();
  console.log(`[Poll] Found ${subscriptions.length} active subscriptions`);
  await logger?.log('poll_fetch_subscriptions', 'completed', { count: subscriptions.length });

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

        // Try to find existing transcript from original podcast RSS first
        let transcriptFound = false;
        
        try {
          // Extract original podcast URL from ListenNotes description
          const podcastUrl = extractOriginalPodcastUrl(episode.description || "");
          
          if (podcastUrl) {
            // Check cache first, then fetch RSS URL
            let originalRssUrl = rssUrlCache.get(podcastUrl);
            if (originalRssUrl === undefined) {
              originalRssUrl = await fetchOriginalRssUrl(podcastUrl);
              rssUrlCache.set(podcastUrl, originalRssUrl);
            }
            
            if (originalRssUrl) {
              // Check for transcript in original RSS
              const transcriptInfo = await findTranscriptInRss(
                originalRssUrl,
                episode.guid,
                episode.title
              );
              
              if (transcriptInfo) {
                // Download the transcript
                const transcriptText = await downloadTranscript(transcriptInfo);
                
                if (transcriptText && transcriptText.length > 100) {
                  console.log(`[Poll] Found existing transcript for: ${episode.title} (${transcriptText.length} chars)`);
                  
                  // Save transcript to storage
                  const transcriptPath = `${insertedEpisode.id}/transcript.json`;
                  const transcriptData = JSON.stringify({ text: transcriptText });
                  
                  await fetch(
                    `${env.SUPABASE_URL}/storage/v1/object/transcripts/${transcriptPath}`,
                    {
                      method: "POST",
                      headers: {
                        ...headers,
                        "Content-Type": "application/json",
                      },
                      body: transcriptData,
                    }
                  );
                  
                  // Create completed transcription record
                  await fetch(
                    `${env.SUPABASE_URL}/rest/v1/transcriptions`,
                    {
                      method: "POST",
                      headers,
                      body: JSON.stringify({
                        episode_id: insertedEpisode.id,
                        status: "completed",
                        transcript_storage_path: transcriptPath,
                        word_count: transcriptText.split(/\s+/).length,
                        completed_at: new Date().toISOString(),
                      }),
                    }
                  );
                  
                  transcriptFound = true;
                  transcriptionsTriggered++;
                  console.log(`[Poll] ✅ Used existing transcript (saved Modal cost!): ${episode.title}`);
                  
                  // Trigger topic extraction and SuperMemory embedding
                  // (normally done by Modal webhook, but we need to do it here)
                  try {
                    await extractTopicsForEpisode(insertedEpisode.id, transcriptText, env);
                    await embedInSuperMemory(insertedEpisode.id, transcriptText, env);
                    console.log(`[Poll] Extracted topics and embedded for: ${episode.title}`);
                  } catch (processingError) {
                    console.error(`[Poll] Post-processing error:`, processingError);
                  }
                }
              }
            }
          }
        } catch (transcriptError) {
          console.log(`[Poll] Transcript lookup failed, will use Modal: ${transcriptError}`);
        }
        
        // Fall back to Modal if no existing transcript found
        if (!transcriptFound) {
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
              console.log(`[Poll] Triggered Modal transcription for: ${episode.title}`);
            } else {
              console.error(`[Poll] Modal trigger failed: ${modalResponse.status}`);
            }
          } catch (modalError) {
            console.error(`[Poll] Modal error:`, modalError);
            errors.push(`Modal error for ${episode.title}: ${modalError}`);
          }
        }
      }
    } catch (subError) {
      const errorMsg = `Error processing ${sub.podcast_title}: ${subError}`;
      console.error(`[Poll] ${errorMsg}`);
      errors.push(errorMsg);
      await logger?.log('poll_subscription_error', 'failed', { 
        podcast_title: sub.podcast_title,
        feed_url: sub.feed_url,
      }, errorMsg);
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

// CORS headers for browser requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Helper to add CORS headers to response
function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

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

    // Modal transcription webhook
    if (url.pathname === "/api/webhooks/modal" && request.method === "POST") {
      return handleModalWebhook(request, env, ctx);
    }
    
    // Modal TTS webhook (updates digest when audio is ready)
    if (url.pathname === "/api/webhooks/tts" && request.method === "POST") {
      return handleTTSWebhook(request, env);
    }
    
    // Manual topic extraction trigger (for testing)
    if (url.pathname === "/api/extract-topics" && request.method === "POST") {
      return handleExtractTopics(request, env);
    }
    
    // Manual SuperMemory embedding trigger (for testing)
    if (url.pathname === "/api/embed-content" && request.method === "POST") {
      return handleEmbedContent(request, env);
    }
    
    // Generate digest (for testing / manual trigger)
    if (url.pathname === "/api/generate-digest" && request.method === "POST") {
      return handleGenerateDigest(request, env, ctx);
    }
    
    // Scheduled digest generation (called by pg_cron via /api/daily-cron)
    if (url.pathname === "/api/scheduled-digest" && request.method === "POST") {
      return handleScheduledDigest(env);
    }
    
    // RSS feed for Spotify
    if (url.pathname.startsWith("/feed/") && request.method === "GET") {
      const userId = url.pathname.replace("/feed/", "").replace(".xml", "");
      return handleRSSFeed(userId, env);
    }
    
    // Re-embed all transcriptions in SuperMemory (admin endpoint)
    // Use ?offset=N&limit=M to paginate
    if (url.pathname === "/api/reembed-all" && request.method === "POST") {
      return handleReembedAll(env, request);
    }
    
    // Admin endpoint to update user profile settings
    if (url.pathname === "/api/admin/update-profile" && request.method === "POST") {
      return handleUpdateProfile(request, env);
    }
    
    // ElevenReader transcript - returns latest digest script as plain text
    // URL: /transcript/latest or /transcript/{userId}
    if (url.pathname.startsWith("/transcript/")) {
      return handleLatestTranscript(url.pathname, env);
    }
    
    // Debug endpoint to check timezone calculation
    if (url.pathname === "/api/debug-cron" && request.method === "GET") {
      const headers = {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      };
      const profilesResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/profiles?select=id,timezone,digest_time`,
        { headers }
      );
      const profiles = await profilesResponse.json() as Array<{
        id: string;
        timezone: string;
        digest_time: string;
      }>;
      
      const now = new Date();
      const debug = profiles.map(profile => {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: profile.timezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const userHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
        const userMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
        const [targetHour] = (profile.digest_time || "06:00:00").split(":").map(Number);
        
        const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: profile.timezone });
        const today = dateFormatter.format(now);
        
        return {
          user_id: profile.id,
          timezone: profile.timezone,
          digest_time: profile.digest_time,
          now_utc: now.toISOString(),
          user_local_time: `${userHour}:${userMinute.toString().padStart(2, '0')}`,
          user_hour: userHour,
          user_minute: userMinute,
          target_hour: targetHour,
          would_trigger: userHour === targetHour && userMinute < 30,
          today_date: today,
          parts_raw: parts.map(p => ({ type: p.type, value: p.value })),
        };
      });
      
      return json({ debug, server_time: now.toISOString() });
    }
    
    // Daily cron trigger - can be called by Supabase pg_cron or external scheduler
    // This runs the full daily workflow: poll + digest
    if (url.pathname === "/api/daily-cron" && request.method === "POST") {
      return handleDailyCron(env, ctx);
    }
    
    // Pipeline observability - view recent runs
    if (url.pathname === "/api/pipeline/runs" && request.method === "GET") {
      return handlePipelineRuns(env, url);
    }
    
    // Pipeline observability - view logs for a specific run
    if (url.pathname.startsWith("/api/pipeline/run/") && request.method === "GET") {
      const runId = url.pathname.replace("/api/pipeline/run/", "");
      return handlePipelineRunLogs(env, runId);
    }
    
    // BYOK: Validate API key (for Settings UI)
    if (url.pathname === "/api/validate-key" && request.method === "POST") {
      return withCors(await handleValidateKey(request));
    }
    
    // BYOK: Save user API keys
    if (url.pathname === "/api/user-keys" && request.method === "POST") {
      return withCors(await handleSaveUserKey(request, env));
    }
    
    // Generate welcome episode for new user
    if (url.pathname === "/api/generate-welcome" && request.method === "POST") {
      return withCors(await handleGenerateWelcome(request, env, ctx));
    }

    return json({ error: "Not found" }, 404);
  },
  // Note: Cron triggers removed - now using Supabase pg_cron via /api/daily-cron endpoint
};

// Internal function to generate digest for a user (used by scheduled cron)
// Returns { success: boolean, error?: string, digest_id?: string }
async function generateDigestForUser(
  env: Env, 
  ctx: ExecutionContext,  // CRITICAL: Need real ctx for waitUntil to work
  userId: string, 
  hoursBack: number
): Promise<{ success: boolean; error?: string; digest_id?: string }> {
  // Create a fake Request object to reuse handleGenerateDigest logic
  const fakeRequest = new Request("https://internal/api/generate-digest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, hours_back: hoursBack }),
  });
  
  try {
    // Pass real ExecutionContext so waitUntil (used for TTS) actually works
    const response = await handleGenerateDigest(fakeRequest, env, ctx);
    const data = await response.json() as { success?: boolean; error?: string; digest_id?: string };
    
    if (response.ok && data.success !== false) {
      return { success: true, digest_id: data.digest_id };
    } else {
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Run scheduled digest - SIMPLIFIED: just check if today's digest exists, generate if not
// The time-based scheduling is handled by pg_cron, we don't need to verify it here
async function runScheduledDigest(env: Env, ctx: ExecutionContext, logger?: PipelineLogger): Promise<{ 
  generated_for: string[], 
  checked_users: number,
  debug?: Array<{
    user_id: string,
    today_date: string,
    digest_exists: boolean,
    action: string
  }>
}> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  const profilesResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?select=id,timezone,digest_time`,
    { headers }
  );
  
  if (!profilesResponse.ok) {
    const errorMsg = "Failed to fetch profiles";
    await logger?.log('digest_fetch_profiles', 'failed', {}, errorMsg);
    throw new Error(errorMsg);
  }
  
  const profiles = await profilesResponse.json() as Array<{
    id: string;
    timezone: string;
    digest_time: string;
  }>;
  
  await logger?.log('digest_fetch_profiles', 'completed', { user_count: profiles.length });
  
  const now = new Date();
  const generatedFor: string[] = [];
  const debugInfo: Array<{
    user_id: string,
    today_date: string,
    digest_exists: boolean,
    action: string
  }> = [];
  
  for (const profile of profiles) {
    // Get today's date in user's timezone
    const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: profile.timezone });
    const today = dateFormatter.format(now);
    
    console.log(`[Cron] Checking user ${profile.id}: timezone=${profile.timezone}, today=${today}`);
    
    const userDebug = {
      user_id: profile.id,
      today_date: today,
      digest_exists: false,
      action: "checking"
    };
    
    // Check if digest already exists for today
    const existingResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${profile.id}&digest_date=eq.${today}&select=id`,
      { headers }
    );
    
    const existing = await existingResponse.json() as Array<{ id: string }>;
    userDebug.digest_exists = existing.length > 0;
    
    if (existing.length === 0) {
      console.log(`[Cron] Generating digest for user ${profile.id}`);
      userDebug.action = "generating";
      await logger?.log('digest_user_generate', 'started', { 
        user_id: profile.id, 
        timezone: profile.timezone,
        today_date: today,
      });
      
      try {
        // Generate digest inline (avoids subrequest limits and self-call issues)
        // Pass ctx so waitUntil works for TTS trigger
        const result = await generateDigestForUser(env, ctx, profile.id, 24);
        if (result.success) {
          generatedFor.push(profile.id);
          userDebug.action = "generated";
          await logger?.log('digest_user_generate', 'completed', { 
            user_id: profile.id, 
            digest_id: result.digest_id,
          });
        } else {
          console.error(`[Cron] Failed to generate for ${profile.id}: ${result.error}`);
          userDebug.action = `generation_failed:${result.error}`;
          await logger?.log('digest_user_generate', 'failed', { user_id: profile.id }, result.error);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Cron] Exception generating for ${profile.id}: ${errorMsg}`);
        userDebug.action = `generation_error:${errorMsg}`;
        await logger?.log('digest_user_generate', 'failed', { user_id: profile.id }, errorMsg);
      }
    } else {
      console.log(`[Cron] Digest already exists for ${profile.id} on ${today}`);
      userDebug.action = "skipped_already_exists";
      await logger?.log('digest_user_skip', 'completed', { 
        user_id: profile.id, 
        reason: 'already_exists',
        today_date: today,
      });
    }
    
    debugInfo.push(userDebug);
  }
  
  return { generated_for: generatedFor, checked_users: profiles.length, debug: debugInfo };
}

// ============================================
// PIPELINE LOGGING
// ============================================

interface PipelineLogger {
  runId: string;
  log: (step: string, status: 'started' | 'completed' | 'failed', details?: Record<string, unknown>, error?: string) => Promise<void>;
}

function createPipelineLogger(env: Env): PipelineLogger {
  const runId = crypto.randomUUID();
  
  return {
    runId,
    log: async (step: string, status: 'started' | 'completed' | 'failed', details?: Record<string, unknown>, error?: string) => {
      try {
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/pipeline_logs`,
          {
            method: "POST",
            headers: {
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
            body: JSON.stringify({
              run_id: runId,
              step,
              status,
              details: details || null,
              error: error || null,
            }),
          }
        );
      } catch (e) {
        // Don't let logging failures break the pipeline
        console.error(`[Logger] Failed to log ${step}:`, e);
      }
    },
  };
}

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
      
      // Trigger topic extraction, SuperMemory embedding, and pgvector embeddings asynchronously
      ctx.waitUntil(
        (async () => {
          // First, do topic extraction and SuperMemory embedding (existing)
          await extractTopicsForEpisode(jobData.episode_id, payload.text, env);
          await embedInSuperMemory(jobData.episode_id, payload.text, env);
          
          // Generate pgvector embeddings using user's OpenAI key (BYOK)
          await generateEmbeddingsForTranscript(jobData.episode_id, payload.text, env);
        })()
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

// Handle TTS completion webhook from Modal
async function handleTTSWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const payload = await request.json() as {
      status: string;
      digest_id?: string;
      audio_url?: string;
      duration_seconds?: number;
      characters?: number;
      error?: string;
    };

    console.log(`[TTS Webhook] Received: status=${payload.status}, digest_id=${payload.digest_id}`);

    if (!payload.digest_id) {
      return json({ error: "digest_id required" }, 400);
    }

    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    };

    if (payload.status === "completed" && payload.audio_url) {
      // Update digest record with audio URL
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/digests?id=eq.${payload.digest_id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            status: "completed",
            audio_url: payload.audio_url,
            duration_seconds: payload.duration_seconds,
            completed_at: new Date().toISOString(),
          }),
        }
      );

      console.log(`[TTS Webhook] Digest ${payload.digest_id} completed: ${payload.audio_url}`);
      return json({ success: true, status: "completed" });
    } else {
      // Update as failed
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/digests?id=eq.${payload.digest_id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ 
            status: "failed", 
            error_message: payload.error || "TTS generation failed",
          }),
        }
      );

      console.log(`[TTS Webhook] Digest ${payload.digest_id} failed: ${payload.error}`);
      return json({ success: true, status: "failed" });
    }
  } catch (error) {
    console.error("[TTS Webhook] Error:", error);
    return json({ error: "Internal error" }, 500);
  }
}

// ============================================
// WELCOME EPISODE GENERATION
// ============================================

/**
 * Generate a personalized welcome episode for a new user.
 * This creates a short audio greeting explaining how Podgest works.
 */
async function handleGenerateWelcome(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    // Extract user_id from JWT token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return json({ error: "Authorization required" }, 401);
    }
    
    const token = authHeader.replace('Bearer ', '');
    let userId: string;
    
    try {
      const payloadBase64 = token.split('.')[1];
      const payload = JSON.parse(atob(payloadBase64));
      userId = payload.sub;
      if (!userId) {
        return json({ error: "Invalid token" }, 401);
      }
    } catch {
      return json({ error: "Invalid token format" }, 401);
    }
    
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Check if user already has a welcome episode (marked with date 1970-01-01)
    const existingResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&digest_date=eq.1970-01-01&select=id,status`,
      { headers }
    );
    const existing = await existingResponse.json() as Array<{ id: string; status: string }>;
    
    if (existing.length > 0) {
      console.log(`[Welcome] User ${userId} already has welcome episode (status: ${existing[0].status})`);
      return json({ success: true, message: "Welcome episode already exists", digest_id: existing[0].id, status: existing[0].status });
    }
    
    // Get user info for personalization
    const profileResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id,email,display_name`,
      { headers }
    );
    
    let userName = "there";
    if (profileResponse.ok) {
      const profiles = await profileResponse.json() as Array<{ id: string; email?: string; display_name?: string }>;
      if (profiles.length > 0) {
        // Prefer display_name, fall back to first name from email
        if (profiles[0].display_name) {
          userName = profiles[0].display_name.split(' ')[0]; // First name from display name
        } else if (profiles[0].email) {
          const emailPart = profiles[0].email.split('@')[0];
          const firstName = emailPart.split(/[._0-9]/)[0];
          if (firstName && firstName.length > 1) {
            userName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
          }
        }
      }
    }
    
    // Get user's OpenAI key for TTS
    const userKeys = await getUserApiKeys(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      userId,
      env.API_KEY_ENCRYPTION_KEY
    );
    
    if (!userKeys.openaiKey) {
      return json({ error: "OpenAI API key required. Please add your key in Settings." }, 400);
    }
    
    // Create the welcome script
    const welcomeScript = `Hey ${userName}! Welcome to Podgest, your personal podcast digest.

Here's how it works: Every morning at 6 AM, I check your subscribed podcasts for new episodes. When I find new content, I transcribe it using AI and identify the most interesting topics and insights.

Then I create a personalized 5-minute audio digest just for you, summarizing the best moments from all your shows. Think of it like having a friend who listens to all your podcasts and gives you the highlights.

Your first real digest will arrive tomorrow morning. In the meantime, feel free to add more podcasts in your settings. The more shows you subscribe to, the richer your daily digest becomes.

You can also connect me to Claude or ChatGPT using the MCP server. This lets you ask questions about any podcast content, like "What did they say about AI on Lex Fridman?" or "Compare what different hosts think about remote work." It's pretty powerful.

Alright, that's the quick tour. I'll catch you tomorrow with your first digest. Welcome aboard!`;

    // Create digest record
    const digestId = crypto.randomUUID();
    const digestRecord = {
      id: digestId,
      user_id: userId,
      digest_date: "1970-01-01",  // Special date marker for welcome episode
      status: "generating",
      topic_clusters: {
        title: `Welcome to Podgest, ${userName}!`,
        topics: ["Introduction", "How it works", "Getting started"],
      },
      script_text: welcomeScript,
      episodes_included: [],
      created_at: new Date().toISOString(),
    };
    
    const insertResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests`,
      {
        method: "POST",
        headers: { ...headers, "Prefer": "return=minimal" },
        body: JSON.stringify(digestRecord),
      }
    );
    
    if (!insertResponse.ok) {
      const err = await insertResponse.text();
      console.error(`[Welcome] Failed to create digest record: ${err}`);
      return json({ error: "Failed to create welcome episode" }, 500);
    }
    
    console.log(`[Welcome] Created digest record ${digestId}, triggering TTS...`);
    
    // Trigger TTS generation
    ctx.waitUntil(
      fetch(
        "https://ptzimmerman--podgest-transcribe-openai-tts-web.modal.run",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            script: welcomeScript,
            openai_api_key: userKeys.openaiKey,
            voice: "echo",
            model: "tts-1-hd",
            supabase_url: env.SUPABASE_URL,
            supabase_key: env.SUPABASE_SERVICE_ROLE_KEY,
            digest_id: digestId,
            webhook_url: "https://podgest-api.pztest.workers.dev/api/webhooks/tts",
          }),
        }
      ).then(res => console.log(`[Welcome] TTS triggered: ${res.status}`))
       .catch(err => console.error(`[Welcome] TTS error: ${err}`))
    );
    
    return json({ 
      success: true, 
      message: "Welcome episode is being generated", 
      digest_id: digestId,
      estimated_time: "~30 seconds"
    });
    
  } catch (error) {
    console.error("[Welcome] Error:", error);
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
  
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get episode to find user via subscription
    const episodeResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${episodeId}&select=id,feed_url`,
      { headers }
    );
    const episodes = await episodeResponse.json() as Array<{ id: string; feed_url: string }>;
    
    if (!episodes.length) {
      console.error(`[Topics] Episode not found: ${episodeId}`);
      return;
    }
    
    // Find user via subscription
    const subResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?feed_url=eq.${encodeURIComponent(episodes[0].feed_url)}&select=user_id&limit=1`,
      { headers }
    );
    const subs = await subResponse.json() as Array<{ user_id: string }>;
    const userId = subs[0]?.user_id;
    
    if (!userId) {
      console.log(`[Topics] No user found for episode, skipping topic extraction`);
      return;
    }
    
    // Get user's Anthropic key (required - no fallback)
    const userKeys = await getUserApiKeys(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      userId,
      env.API_KEY_ENCRYPTION_KEY
    );
    
    if (!userKeys.anthropicKey) {
      console.error(`[Topics] User ${userId} does not have Anthropic key configured, skipping topic extraction`);
      return;
    }
    
    const result = await callClaudeForTopics(transcriptText, userKeys.anthropicKey);
    
    // Get transcription ID
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
    
    // Get episode metadata (including description for original podcast name extraction)
    const episodeResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${episodeId}&select=id,title,published_at,feed_url,description`,
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
      description?: string;
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
    
    // Extract original podcast name from description (for ListenNotes aggregated feeds)
    const originalPodcastName = extractOriginalPodcastName(episode.description || "");
    const podcastTitle = originalPodcastName || subs[0]?.podcast_title || "Unknown Podcast";
    console.log(`[SuperMemory] Using podcast title: ${podcastTitle} (original: ${originalPodcastName}, fallback: ${subs[0]?.podcast_title})`);
    
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

// ============================================
// PGVECTOR EMBEDDING GENERATION (BYOK)
// ============================================

/**
 * Generate pgvector embeddings for a transcript using the user's OpenAI key.
 * Requires user to have OpenAI key configured - no fallbacks.
 */
async function generateEmbeddingsForTranscript(episodeId: string, transcriptText: string, env: Env): Promise<void> {
  console.log(`[Embeddings] Starting pgvector embedding for episode: ${episodeId}`);
  
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // 1. Get episode to find the feed_url
    const episodeResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${episodeId}&select=id,feed_url`,
      { headers }
    );
    
    if (!episodeResponse.ok) {
      console.error(`[Embeddings] Failed to fetch episode: ${episodeResponse.status}`);
      return;
    }
    
    const episodes = await episodeResponse.json() as Array<{ id: string; feed_url: string }>;
    if (!episodes.length) {
      console.error(`[Embeddings] Episode not found: ${episodeId}`);
      return;
    }
    
    // 2. Find user via subscription
    const subResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?feed_url=eq.${encodeURIComponent(episodes[0].feed_url)}&select=user_id&limit=1`,
      { headers }
    );
    
    const subs = await subResponse.json() as Array<{ user_id: string }>;
    const userId = subs[0]?.user_id;
    
    if (!userId) {
      console.log(`[Embeddings] No user found for episode, skipping pgvector embedding`);
      return;
    }
    
    // 3. Get user's OpenAI key (required - no fallback)
    let openaiKey: string | undefined;
    
    try {
      const userKeys = await getUserApiKeys(
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_ROLE_KEY,
        userId,
        env.API_KEY_ENCRYPTION_KEY
      );
      
      openaiKey = userKeys.openaiKey;
      
      if (!openaiKey) {
        console.error(`[Embeddings] User ${userId} does not have OpenAI key configured, skipping embeddings`);
        return;
      }
      
      console.log(`[Embeddings] Using user's OpenAI key for user ${userId}`);
    } catch (keyError) {
      console.error(`[Embeddings] Failed to fetch user keys: ${keyError}`);
      return;
    }
    
    // 4. Get transcription ID
    const transcriptionResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${episodeId}&select=id`,
      { headers }
    );
    const transcriptions = await transcriptionResponse.json() as Array<{ id: string }>;
    
    if (!transcriptions.length) {
      console.error(`[Embeddings] Transcription not found for episode: ${episodeId}`);
      return;
    }
    
    const transcriptionId = transcriptions[0].id;
    
    // 5. Generate chunked embeddings
    console.log(`[Embeddings] Generating embeddings for transcript (${transcriptText.length} chars)...`);
    const chunkedEmbeddings = await generateChunkedEmbeddings(transcriptText, openaiKey);
    
    console.log(`[Embeddings] Generated ${chunkedEmbeddings.length} chunks for episode ${episodeId}`);
    
    // 6. Store embeddings in transcript_embeddings table
    for (const chunk of chunkedEmbeddings) {
      const insertResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/transcript_embeddings`,
        {
          method: "POST",
          headers: { ...headers, "Prefer": "return=minimal" },
          body: JSON.stringify({
            transcription_id: transcriptionId,
            chunk_index: chunk.chunkIndex,
            chunk_text: chunk.chunkText,
            word_count: chunk.wordCount,
            embedding: JSON.stringify(chunk.embedding), // pgvector expects array as string
          }),
        }
      );
      
      if (!insertResponse.ok) {
        const err = await insertResponse.text();
        console.error(`[Embeddings] Failed to insert chunk ${chunk.chunkIndex}: ${err}`);
      }
    }
    
    console.log(`[Embeddings] ✅ Stored ${chunkedEmbeddings.length} embeddings for episode ${episodeId}`);
    
  } catch (error) {
    console.error(`[Embeddings] Error for episode ${episodeId}:`, error);
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

// Admin endpoint to update user profile settings (timezone, digest_time)
async function handleUpdateProfile(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as {
      user_id: string;
      timezone?: string;
      digest_time?: string;
      digest_length_minutes?: number;
    };
    
    if (!body.user_id) {
      return json({ error: "user_id required" }, 400);
    }
    
    const updates: Record<string, unknown> = {};
    if (body.timezone) updates.timezone = body.timezone;
    if (body.digest_time) updates.digest_time = body.digest_time;
    if (body.digest_length_minutes) updates.digest_length_minutes = body.digest_length_minutes;
    
    if (Object.keys(updates).length === 0) {
      return json({ error: "No updates provided" }, 400);
    }
    
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${body.user_id}`,
      {
        method: "PATCH",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: JSON.stringify(updates),
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      return json({ error: "Failed to update profile", details: error }, 500);
    }
    
    const updated = await response.json();
    return json({ success: true, profile: updated });
    
  } catch (error) {
    console.error("[UpdateProfile] Error:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// Serve the latest digest transcript for ElevenReader
// URL: /transcript/latest or /transcript/{userId}
async function handleLatestTranscript(pathname: string, env: Env): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
  
  // Get user ID - either from path or use default
  let userId = "18f513bd-8ecf-4922-84b7-4ab7c7cc14df"; // Default user
  const pathParts = pathname.split("/");
  if (pathParts[2] && pathParts[2] !== "latest") {
    userId = pathParts[2];
  }
  
  // Get the latest completed digest for this user
  const digestResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&status=eq.completed&order=created_at.desc&limit=1`,
    { headers }
  );
  
  if (!digestResponse.ok) {
    return new Response("Error fetching digest", { status: 500 });
  }
  
  const digests = await digestResponse.json() as Array<{
    id: string;
    digest_date: string;
    topic_clusters: { title: string; topics: string[] };
    script_text?: string;
  }>;
  
  if (!digests.length) {
    return new Response("No digest found", { status: 404 });
  }
  
  const digest = digests[0];
  
  // If we have script_text stored, use that
  if (digest.script_text) {
    return new Response(digest.script_text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      },
    });
  }
  
  // Otherwise, generate a summary from topic_clusters
  const topics = digest.topic_clusters?.topics || [];
  const title = digest.topic_clusters?.title || `Podgest - ${digest.digest_date}`;
  
  const transcript = `${title}

Today's topics:
${topics.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Listen to the full audio digest at:
https://xpviiukiavtpsnafpdmy.supabase.co/storage/v1/object/public/digests/${digest.id}/digest.mp3
`;
  
  return new Response(transcript, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

// Daily cron trigger - can be called by Supabase pg_cron or any external scheduler
// This runs: 1) Poll RSS feeds, 2) Generate digest for users who need one
// Runs synchronously - pg_net should be configured with 60s+ timeout
async function handleDailyCron(env: Env, ctx: ExecutionContext): Promise<Response> {
  const startTime = new Date().toISOString();
  const logger = createPipelineLogger(env);
  
  console.log(`[DailyCron] Starting daily workflow at ${startTime}, run_id=${logger.runId}`);
  await logger.log('cron_start', 'started', { timestamp: startTime });
  
  let pollResult: unknown = null;
  let digestResult: unknown = null;
  
  try {
    // Step 1: Poll all RSS feeds
    console.log("[DailyCron] Step 1: Polling RSS feeds...");
    await logger.log('poll_start', 'started');
    
    pollResult = await pollAllSubscriptions(env, logger);
    
    await logger.log('poll_complete', 'completed', pollResult as Record<string, unknown>);
    console.log(`[DailyCron] Poll complete: ${JSON.stringify(pollResult)}`);
    
    // Step 2: Run scheduled digest check for all users
    console.log("[DailyCron] Step 2: Running scheduled digest generation...");
    await logger.log('digest_start', 'started');
    
    digestResult = await runScheduledDigest(env, ctx, logger);
    
    await logger.log('digest_complete', 'completed', digestResult as Record<string, unknown>);
    console.log(`[DailyCron] Digest check complete: ${JSON.stringify(digestResult)}`);
    
    await logger.log('cron_complete', 'completed', {
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - new Date(startTime).getTime(),
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[DailyCron] Error: ${error}`);
    await logger.log('cron_error', 'failed', { poll_result: pollResult, digest_result: digestResult }, errorMsg);
    
    return json({
      success: false,
      error: errorMsg,
      run_id: logger.runId,
      timestamp: startTime,
      poll_result: pollResult,
      digest_result: digestResult,
    }, 500);
  }
  
  return json({
    success: true,
    status: "completed",
    run_id: logger.runId,
    timestamp: startTime,
    poll_result: pollResult,
    digest_result: digestResult,
  });
}

async function handleReembedAll(env: Env, request?: Request): Promise<Response> {
  // Parse offset from query string if request provided
  let offset = 0;
  let limit = 6; // Process 6 at a time to stay under subrequest limit
  
  if (request) {
    const url = new URL(request.url);
    offset = parseInt(url.searchParams.get("offset") || "0");
    limit = parseInt(url.searchParams.get("limit") || "6");
  }
  
  console.log(`[ReembedAll] Starting re-embedding with offset=${offset}, limit=${limit}`);
  
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get completed transcriptions with pagination
    const transcriptionsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?status=eq.completed&select=id,episode_id,supermemory_doc_id,transcript_storage_path&order=id&offset=${offset}&limit=${limit}`,
      { headers }
    );
    
    if (!transcriptionsResponse.ok) {
      return json({ error: "Failed to fetch transcriptions" }, 500);
    }
    
    const transcriptions = await transcriptionsResponse.json() as Array<{
      id: string;
      episode_id: string;
      supermemory_doc_id: string | null;
      transcript_storage_path: string;
    }>;
    
    console.log(`[ReembedAll] Found ${transcriptions.length} transcriptions to re-embed`);
    
    const results: Array<{ episode_id: string; status: string; error?: string }> = [];
    
    for (const t of transcriptions) {
      try {
        // Delete old SuperMemory doc if exists
        if (t.supermemory_doc_id) {
          console.log(`[ReembedAll] Deleting old doc ${t.supermemory_doc_id} for episode ${t.episode_id}`);
          const deleteResponse = await fetch(
            `https://api.supermemory.ai/v3/documents/${t.supermemory_doc_id}`,
            {
              method: "DELETE",
              headers: {
                "Authorization": `Bearer ${env.SUPERMEMORY_API_KEY}`,
              },
            }
          );
          
          if (!deleteResponse.ok) {
            console.warn(`[ReembedAll] Failed to delete old doc: ${deleteResponse.status}`);
          }
        }
        
        // Download transcript from storage
        const transcriptUrl = `${env.SUPABASE_URL}/storage/v1/object/transcripts/${t.transcript_storage_path}`;
        const transcriptResponse = await fetch(transcriptUrl, {
          headers: {
            "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
        
        if (!transcriptResponse.ok) {
          results.push({ episode_id: t.episode_id, status: "error", error: "Transcript not found" });
          continue;
        }
        
        const transcript = await transcriptResponse.json() as { text: string };
        
        // Re-embed with correct metadata
        await embedInSuperMemory(t.episode_id, transcript.text, env);
        
        results.push({ episode_id: t.episode_id, status: "success" });
        console.log(`[ReembedAll] Re-embedded episode ${t.episode_id}`);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        results.push({ 
          episode_id: t.episode_id, 
          status: "error", 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }
    
    const successful = results.filter(r => r.status === "success").length;
    const failed = results.filter(r => r.status === "error").length;
    
    console.log(`[ReembedAll] Complete: ${successful} successful, ${failed} failed`);
    
    const hasMore = transcriptions.length === limit;
    const nextOffset = hasMore ? offset + limit : null;
    
    return json({
      batch_size: transcriptions.length,
      offset,
      successful,
      failed,
      next_offset: nextOffset,
      results,
    });
    
  } catch (error) {
    console.error("[ReembedAll] Error:", error);
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
    
    // Get episode to find user via subscription
    const episodeResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${episode_id}&select=id,feed_url`,
      { headers }
    );
    const episodes = await episodeResponse.json() as Array<{ id: string; feed_url: string }>;
    
    if (!episodes.length) {
      return json({ error: "Episode not found" }, 404);
    }
    
    // Find user via subscription
    const subResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?feed_url=eq.${encodeURIComponent(episodes[0].feed_url)}&select=user_id&limit=1`,
      { headers }
    );
    const subs = await subResponse.json() as Array<{ user_id: string }>;
    const userId = subs[0]?.user_id;
    
    if (!userId) {
      return json({ error: "No user found for this episode" }, 400);
    }
    
    // Get user's Anthropic key (required - no fallback)
    const userKeys = await getUserApiKeys(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      userId,
      env.API_KEY_ENCRYPTION_KEY
    );
    
    if (!userKeys.anthropicKey) {
      return json({ error: "Anthropic API key not configured. Please add your API key in Settings." }, 400);
    }
    
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
    const result = await callClaudeForTopics(transcript.text, userKeys.anthropicKey);
    
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

// Check which users need digests generated based on their timezone and digest_time
async function handleScheduledDigest(env: Env): Promise<Response> {
  try {
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Get all users with their timezone and digest preferences
    const profilesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?select=id,timezone,digest_time`,
      { headers }
    );
    
    if (!profilesResponse.ok) {
      return json({ error: "Failed to fetch profiles" }, 500);
    }
    
    const profiles = await profilesResponse.json() as Array<{
      id: string;
      timezone: string;
      digest_time: string;
    }>;
    
    const now = new Date();
    const generatedFor: string[] = [];
    const debugInfo: Array<{
      user_id: string;
      timezone: string;
      digest_time: string;
      current_user_hour: number;
      current_user_minute: number;
      target_hour: number;
      hour_matches: boolean;
      would_generate: boolean;
      reason: string;
    }> = [];
    
    for (const profile of profiles) {
      // Get current time in user's timezone using Intl API (more reliable)
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: profile.timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      const userHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
      const userMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
      
      // Parse digest_time (e.g., "06:00:00")
      const [targetHour] = (profile.digest_time || "06:00:00").split(":").map(Number);
      
      const hourMatches = userHour === targetHour;
      const inWindow = userMinute < 30;
      
      let reason = "";
      let wouldGenerate = false;
      
      // Check if current hour matches digest time (within the hour window)
      if (hourMatches && inWindow) {
        // Check if we already generated a digest today for this user
        const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: profile.timezone });
        const today = dateFormatter.format(now); // Returns YYYY-MM-DD format
        
        const existingResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${profile.id}&digest_date=eq.${today}&select=id`,
          { headers }
        );
        
        const existing = await existingResponse.json() as Array<{ id: string }>;
        
        if (existing.length === 0) {
          // Generate digest for this user
          console.log(`[Scheduled] Generating digest for user ${profile.id} (${profile.timezone} @ ${userHour}:${userMinute})`);
          
          // Call the generate endpoint internally
          const generateResponse = await fetch(
            `https://podgest-api.pztest.workers.dev/api/generate-digest`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                user_id: profile.id,
                hours_back: 24,
              }),
            }
          );
          
          if (generateResponse.ok) {
            generatedFor.push(profile.id);
            wouldGenerate = true;
            reason = "Generated successfully";
          } else {
            reason = `Generation failed: ${await generateResponse.text()}`;
          }
        } else {
          reason = `Digest already exists for ${today}`;
        }
      } else if (!hourMatches) {
        reason = `Hour mismatch: current=${userHour}, target=${targetHour}`;
      } else {
        reason = `Outside 30-min window: minute=${userMinute}`;
      }
      
      debugInfo.push({
        user_id: profile.id,
        timezone: profile.timezone,
        digest_time: profile.digest_time,
        current_user_hour: userHour,
        current_user_minute: userMinute,
        target_hour: targetHour,
        hour_matches: hourMatches,
        would_generate: wouldGenerate,
        reason,
      });
    }
    
    return json({
      checked_users: profiles.length,
      generated_for: generatedFor,
      current_utc: now.toISOString(),
      debug: debugInfo,
    });
    
  } catch (error) {
    console.error("[Scheduled] Error:", error);
    return json({ error: String(error) }, 500);
  }
}

async function handleGenerateDigest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const body = await request.json() as { 
      user_id?: string; 
      hours_back?: number;
    };
    
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    const hoursBack = body.hours_back || 24;
    const userId = body.user_id || "00000000-0000-0000-0000-000000000000";
    
    // Fixed at 5 minutes for now (avoids Cloudflare Worker CPU limits)
    const maxLengthMinutes = 5;
    
    console.log(`[Digest] Generating ${maxLengthMinutes}-minute digest for last ${hoursBack} hours`);
    
    // BYOK: Fetch user's API keys (required - no fallbacks)
    let userAnthropicKey: string | undefined;
    let userOpenAIKey: string | undefined;
    let userElevenLabsKey: string | undefined;
    
    if (userId === "00000000-0000-0000-0000-000000000000") {
      return json({ error: "Valid user ID is required" }, 400);
    }
    
    try {
      const userKeys = await getUserApiKeys(
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_ROLE_KEY,
        userId,
        env.API_KEY_ENCRYPTION_KEY
      );
      
      userAnthropicKey = userKeys.anthropicKey;
      userOpenAIKey = userKeys.openaiKey;
      userElevenLabsKey = userKeys.elevenlabsKey;
      
      if (!userAnthropicKey) {
        console.error(`[Digest] User ${userId} does not have Anthropic key configured`);
        return json({ error: "Anthropic API key not configured. Please add your API key in Settings." }, 400);
      }
      
      console.log(`[Digest] Using user's API keys for user ${userId}`);
    } catch (keyError) {
      console.error(`[Digest] Failed to fetch user keys: ${keyError}`);
      return json({ error: "Failed to retrieve API keys. Please configure your keys in Settings." }, 500);
    }
    
    // 1. Get episodes already covered in THIS USER's recent digests (last 7 days) to avoid repeats
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const recentDigestsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&digest_date=gte.${weekAgo}&select=episodes_included`,
      { headers }
    );
    
    let alreadyCoveredEpisodes = new Set<string>();
    if (recentDigestsResponse.ok) {
      const recentDigests = await recentDigestsResponse.json() as Array<{ episodes_included: string[] }>;
      for (const digest of recentDigests) {
        for (const epId of (digest.episodes_included || [])) {
          alreadyCoveredEpisodes.add(epId);
        }
      }
    }
    console.log(`[Digest] Found ${alreadyCoveredEpisodes.size} episodes already covered in recent digests`);
    
    // 2. Fetch recent episodes with their topic extractions
    const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    
    const episodesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?created_at=gte.${cutoffDate}&select=id,title,description,published_at,feed_url`,
      { headers }
    );
    
    if (!episodesResponse.ok) {
      return json({ error: "Failed to fetch episodes" }, 500);
    }
    
    let episodes = await episodesResponse.json() as Array<{
      id: string;
      title: string;
      description: string;
      published_at: string;
      feed_url: string;
    }>;
    
    // Get podcast names from subscriptions for citation
    const feedUrls = [...new Set(episodes.map(e => e.feed_url))];
    const subscriptionsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?feed_url=in.(${feedUrls.map(u => `"${u}"`).join(",")})&select=feed_url,podcast_title`,
      { headers }
    );
    const podcastNames = new Map<string, string>();
    if (subscriptionsResponse.ok) {
      const subs = await subscriptionsResponse.json() as Array<{ feed_url: string; podcast_title: string }>;
      for (const sub of subs) {
        podcastNames.set(sub.feed_url, sub.podcast_title);
      }
    }
    
    // Filter out episodes already covered in recent digests
    const originalCount = episodes.length;
    episodes = episodes.filter(ep => !alreadyCoveredEpisodes.has(ep.id));
    
    // Filter out excluded content creators (e.g., Peter Zeihan)
    const beforeExclusion = episodes.length;
    episodes = episodes.filter(ep => !shouldExcludeEpisode(ep.title, ep.description || ""));
    const excludedCount = beforeExclusion - episodes.length;
    if (excludedCount > 0) {
      console.log(`[Digest] Excluded ${excludedCount} episodes from blocked sources`);
    }
    
    console.log(`[Digest] ${originalCount} recent episodes, ${episodes.length} eligible for digest`);
    
    if (!episodes.length) {
      return json({ 
        error: "No new episodes to cover - all recent episodes were in previous digests",
        hours_back: hoursBack,
        already_covered: originalCount
      }, 404);
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
    
    // 3. Build context for Claude (including podcast name for citations)
    // For ListenNotes feeds, extract the original podcast name from description
    const episodeSummaries = episodes.map(ep => {
      const topics = episodeTopics.get(ep.id);
      // Try to extract original podcast name from ListenNotes description
      const originalPodcastName = extractOriginalPodcastName(ep.description || "");
      // Fall back to subscription's podcast_title only if no original found
      const podcastName = originalPodcastName || podcastNames.get(ep.feed_url) || "Unknown Podcast";
      return {
        title: ep.title,
        podcast_name: podcastName,
        summary: topics?.summary || ep.description?.substring(0, 200) || "No summary available",
        topics: topics?.topics || [],
        themes: topics?.themes || [],
        key_points: topics?.key_points || [],
      };
    });
    
    console.log(`[Digest] Generating script with Claude...`);
    
    // 4. Generate news broadcaster script with Claude (using user's key if available)
    const script = await generateDigestScript(episodeSummaries, maxLengthMinutes, userAnthropicKey);
    
    console.log(`[Digest] Script generated: ${script.word_count} words`);
    
    // 5. Save pending digest record first (so we can update it when TTS completes)
    const digestId = crypto.randomUUID();
    const estimatedDuration = Math.round(script.word_count / 2.5);
    
    const digestRecord = {
      id: digestId,
      user_id: userId,
      digest_date: new Date().toISOString().split('T')[0],
      status: "generating", // Will be updated to "completed" by webhook
      topic_clusters: { topics: script.topics_covered, title: script.title },
      script_text: script.script, // Store full script for ElevenReader
      audio_storage_path: `${digestId}/digest.mp3`,
      audio_url: null, // Will be set by webhook
      duration_seconds: estimatedDuration,
      episodes_included: episodeIds,
      completed_at: null,
    };
    
    // Use upsert to allow regenerating same-day digests
    const insertDigestResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?on_conflict=user_id,digest_date`,
      {
        method: "POST",
        headers: { 
          ...headers, 
          "Prefer": "return=representation,resolution=merge-duplicates" 
        },
        body: JSON.stringify(digestRecord),
      }
    );
    
    if (!insertDigestResponse.ok) {
      const errorText = await insertDigestResponse.text();
      console.error(`[Digest] Failed to save record: ${errorText}`);
      return json({ error: "Failed to save digest record", details: errorText }, 500);
    }
    
    console.log(`[Digest] Saved pending digest ${digestId}`);
    
    // 6. Trigger Modal TTS asynchronously with webhook callback (using OpenAI - 10x cheaper)
    // Uses user's OpenAI key if available, falls back to env key
    console.log(`[Digest] Triggering OpenAI TTS for ${script.script.length} chars...`);
    
    // Use waitUntil to ensure the request is sent even after response is returned
    ctx.waitUntil(
      fetch(
        "https://ptzimmerman--podgest-transcribe-openai-tts-web.modal.run",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            script: script.script,
            openai_api_key: userOpenAIKey,  // BYOK: Use user's key if available
            voice: "echo",  // Warm, conversational voice
            model: "tts-1-hd",  // High quality
            supabase_url: env.SUPABASE_URL,
            supabase_key: env.SUPABASE_SERVICE_ROLE_KEY,
            digest_id: digestId,
            webhook_url: "https://podgest-api.pztest.workers.dev/api/webhooks/tts",
          }),
        }
      ).then(res => console.log(`[Digest] OpenAI TTS triggered: ${res.status}`))
       .catch(err => console.error(`[Digest] Modal trigger error: ${err}`))
    );
    
    // Return immediately - audio will be ready in ~1 minute
    return json({
      success: true,
      status: "generating",
      message: "Digest script generated, audio processing in background. Check back in ~1 minute.",
      digest_id: digestId,
      episodes_count: episodes.length,
      estimated_duration_seconds: estimatedDuration,
      script: {
        title: script.title,
        word_count: script.word_count,
        topics_covered: script.topics_covered,
        preview: script.script.substring(0, 500) + "...",
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
    podcast_name: string;
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
  
  // Get today's date for the intro
  const today = new Date();
  const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  
  const systemPrompt = `You are Alex Chen, an upbeat and energetic podcast host for "Podgest" - a daily news digest show.
Your style is enthusiastic, warm, and engaging - but STRICTLY NEUTRAL. You deliver facts, not opinions.

CRITICAL RULE: You are a NEWS READER, not a commentator. 
- DO NOT add your own opinions, reactions, or editorial commentary
- DO NOT use phrases like "What's fascinating is...", "Here's where it gets interesting...", "What really caught my attention..."
- DO NOT editorialize with "This is huge", "shocking", "remarkable", etc.
- JUST report what was said on the source podcasts, attributed to them
- Let the facts speak for themselves

CRITICAL: The script MUST be approximately ${targetWordCount} words long (${maxMinutes} minutes at 150 words/minute). 
This is a hard requirement - expand on stories with detail and analysis to hit this target.

STRUCTURE YOUR SCRIPT EXACTLY LIKE THIS:

1. OPENING (warm, energetic):
   "Hey there! It's ${dayOfWeek}, ${dateStr}, and this is the Podgest Podcast. I'm Alex Chen, and I've got a great lineup for you today. [PAUSE] Here's what's on deck: [brief 2-3 sentence preview of main themes]. Let's get into it! [PAUSE]"

2. MAIN CONTENT - Group stories into 3-5 SECTIONS by theme (e.g., "Markets & Money", "Politics & Policy", "Tech & Innovation", "Culture & Ideas"):
   - Start each section with a transition: "Alright, let's talk about [SECTION NAME]. [PAUSE]"
   - Cover each story with: context, key details, why it matters, brief analysis
   - CITE YOUR SOURCES naturally like a broadcaster:
     * "Over on [Podcast Name], they reported..."
     * "According to [Podcast Name]..."
     * "[Podcast Name] covered..."
     * "As discussed on [Podcast Name]..."
   
   CRITICAL - ACCURATE CITATIONS:
   - ONLY cite a podcast for information that actually came from that podcast
   - Each story below has a "Source Podcast" field - use ONLY that podcast name when citing that story's content
   - DO NOT mix up sources - if "Prof G Markets" discussed Delta Airlines, do NOT say "The Daily" discussed it
   - When in doubt, cite the specific source podcast listed for each story
   
   - Be warm and engaging but NEUTRAL - no opinions, no editorializing, no reactions
   - Just deliver the facts as reported by the source podcasts
   - End each section with: "And that wraps up [SECTION NAME]. [PAUSE]"

3. CLOSING (tie it together):
   - "Alright, let's zoom out for a second. [PAUSE]"
   - Draw connections between stories - what themes emerged today?
   - End with: "That's your Podgest for ${dayOfWeek}. Thanks for hanging out with me today - I'll catch you tomorrow. Until then, stay curious! [PAUSE]"

IMPORTANT FORMATTING:
- Include [PAUSE] markers where natural breaks should occur (between sections, after transitions)
- Write in a conversational, slightly upbeat tone - avoid being dry or overly formal
- Use contractions naturally (I'm, you'll, here's, that's)
- Vary sentence length for natural rhythm

Return a JSON object with this structure:
{
  "title": "Podgest - ${dateStr}",
  "script": "Hey there! It's ${dayOfWeek}... [full script with [PAUSE] markers]",
  "topics_covered": ["topic1", "topic2", ...],
  "word_count": 450
}

IMPORTANT: Return ONLY the JSON object, no markdown formatting.`;

  const episodeContext = episodes.map((ep, i) => 
    `Story ${i + 1}: "${ep.title}"
Source Podcast: ${ep.podcast_name}
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
    
    // Fetch user profile for personalization
    const profileResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id,email,display_name`,
      { headers }
    );
    
    let userName = "there";
    if (profileResponse.ok) {
      const profiles = await profileResponse.json() as Array<{ id: string; email?: string; display_name?: string }>;
      if (profiles.length > 0) {
        // Prefer display_name, fall back to first name from email
        if (profiles[0].display_name) {
          userName = profiles[0].display_name.split(' ')[0]; // First name from display name
        } else if (profiles[0].email) {
          const emailPart = profiles[0].email.split('@')[0];
          const firstName = emailPart.split(/[._0-9]/)[0];
          if (firstName && firstName.length > 1) {
            userName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
          }
        }
      }
    }
    
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
    const feedUrl = `https://podgest-api.pztest.workers.dev/feed/${userId}.xml`;
    const now = new Date().toUTCString();
    const coverImage = "https://xpviiukiavtpsnafpdmy.supabase.co/storage/v1/object/public/digests/cover.png";
    const welcomeAudio = "https://xpviiukiavtpsnafpdmy.supabase.co/storage/v1/object/public/digests/welcome.mp3";
    
    // Build items with actual file sizes
    const items: string[] = [];
    
    // Check for welcome episode (if no regular digests)
    if (digests.length === 0) {
      // Fetch welcome episode if it exists (marked with date 1970-01-01)
      const welcomeResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&digest_date=eq.1970-01-01&status=eq.completed&select=*`,
        { headers }
      );
      
      if (welcomeResponse.ok) {
        const welcomeDigests = await welcomeResponse.json() as Array<{
          id: string;
          topic_clusters: { title: string; topics: string[] };
          audio_url: string;
          duration_seconds: number;
          completed_at: string;
          script_text: string;
        }>;
        
        if (welcomeDigests.length > 0) {
          const welcome = welcomeDigests[0];
          const welcomeDate = new Date(welcome.completed_at).toUTCString();
          const description = welcome.script_text || "Welcome to Podgest! Your first real digest arrives tomorrow morning.";
          const duration = formatDuration(welcome.duration_seconds || 60);
          
          // Get file size
          let fileSize = 0;
          try {
            const headResponse = await fetch(welcome.audio_url, { method: "HEAD" });
            const contentLength = headResponse.headers.get("content-length");
            if (contentLength) {
              fileSize = parseInt(contentLength, 10);
            }
          } catch (e) {
            console.error(`[RSS] Failed to get welcome file size`);
          }
          
          items.push(`
    <item>
      <title><![CDATA[${welcome.topic_clusters?.title || `Welcome to Podgest, ${userName}!`}]]></title>
      <description><![CDATA[${description}]]></description>
      <pubDate>${welcomeDate}</pubDate>
      <guid isPermaLink="false">${welcome.id}</guid>
      <enclosure url="${welcome.audio_url}" length="${fileSize}" type="audio/mpeg"/>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
      <itunes:episodeType>trailer</itunes:episodeType>
      <itunes:summary>Your first daily digest arrives tomorrow morning!</itunes:summary>
    </item>`);
        }
      }
    }
    
    // Add actual digest episodes
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
      <itunes:episodeType>full</itunes:episodeType>
    </item>`);
    }
    
    const feedTitle = digests.length === 0 
      ? `Podgest - ${userName}'s Daily Digest`
      : "Podgest Daily Digest";
    
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${feedTitle}</title>
    <description>Your personalized podcast news digest, delivered daily. AI-powered summaries of your favorite podcasts.</description>
    <link>${feedUrl}</link>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <itunes:author>Podgest</itunes:author>
    <itunes:summary>AI-powered daily digest of your favorite podcasts, personalized for ${userName}.</itunes:summary>
    <itunes:category text="News">
      <itunes:category text="Daily News"/>
    </itunes:category>
    <itunes:explicit>no</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <itunes:owner>
      <itunes:name>Podgest</itunes:name>
      <itunes:email>hello@podgest.app</itunes:email>
    </itunes:owner>
    <itunes:image href="${coverImage}"/>
    <image>
      <url>${coverImage}</url>
      <title>${feedTitle}</title>
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

// ============================================
// PIPELINE OBSERVABILITY ENDPOINTS
// ============================================

async function handlePipelineRuns(env: Env, url: URL): Promise<Response> {
  const limit = parseInt(url.searchParams.get("limit") || "10");
  
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/get_recent_pipeline_runs`,
      {
        method: "POST",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit_count: limit }),
      }
    );
    
    if (!response.ok) {
      const err = await response.text();
      return json({ error: "Failed to fetch pipeline runs", details: err }, 500);
    }
    
    const runs = await response.json();
    return json({ runs });
    
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handlePipelineRunLogs(env: Env, runId: string): Promise<Response> {
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/get_pipeline_run_logs`,
      {
        method: "POST",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_run_id: runId }),
      }
    );
    
    if (!response.ok) {
      const err = await response.text();
      return json({ error: "Failed to fetch pipeline logs", details: err }, 500);
    }
    
    const logs = await response.json();
    return json({ run_id: runId, logs });
    
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ============================================
// BYOK API KEY MANAGEMENT ENDPOINTS
// ============================================

/**
 * Validate an API key by testing it against the provider's API.
 * POST /api/validate-key
 * Body: { key_type: 'openai' | 'anthropic' | 'elevenlabs', key: string }
 */
async function handleValidateKey(request: Request): Promise<Response> {
  try {
    const body = await request.json() as {
      key_type: 'openai' | 'anthropic' | 'elevenlabs';
      key: string;
    };
    
    if (!body.key_type || !body.key) {
      return json({ valid: false, error: "key_type and key are required" }, 400);
    }
    
    let valid = false;
    let error: string | undefined;
    
    switch (body.key_type) {
      case 'openai':
        valid = await validateOpenAIKey(body.key);
        if (!valid) error = "Invalid OpenAI API key";
        break;
        
      case 'anthropic':
        valid = await validateAnthropicKey(body.key);
        if (!valid) error = "Invalid Anthropic API key";
        break;
        
      case 'elevenlabs':
        valid = await validateElevenLabsKey(body.key);
        if (!valid) error = "Invalid ElevenLabs API key";
        break;
        
      default:
        return json({ valid: false, error: `Invalid key_type: ${body.key_type}` }, 400);
    }
    
    return json({ valid, error });
    
  } catch (error) {
    console.error("[ValidateKey] Error:", error);
    return json({ 
      valid: false, 
      error: error instanceof Error ? error.message : "Validation failed" 
    }, 500);
  }
}

/**
 * Save an encrypted API key for a user.
 * POST /api/user-keys
 * Body: { user_id: string, key_type: 'openai' | 'anthropic' | 'elevenlabs', encrypted_key: string }
 * 
 * Note: The frontend should encrypt the key before sending using the same encryption scheme.
 * Alternatively, we can accept the plaintext key and encrypt it here.
 */
async function handleSaveUserKey(request: Request, env: Env): Promise<Response> {
  try {
    // Extract user_id from JWT token in Authorization header
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return json({ error: "Authorization header required" }, 401);
    }
    
    const token = authHeader.replace('Bearer ', '');
    let userId: string;
    
    try {
      // Decode JWT to get user ID (the 'sub' claim)
      // JWT format: header.payload.signature
      const payloadBase64 = token.split('.')[1];
      const payload = JSON.parse(atob(payloadBase64));
      userId = payload.sub;
      
      if (!userId) {
        return json({ error: "Invalid token: missing user ID" }, 401);
      }
    } catch {
      return json({ error: "Invalid token format" }, 401);
    }
    
    const body = await request.json() as {
      key_type: 'openai' | 'anthropic' | 'elevenlabs';
      key: string;  // Plaintext key (we'll encrypt it)
    };
    
    if (!body.key_type) {
      return json({ error: "key_type is required" }, 400);
    }
    
    if (!body.key) {
      return json({ error: "key is required" }, 400);
    }
    
    // Encrypt the plaintext key
    const encryptedKey = await encryptApiKey(body.key, env.API_KEY_ENCRYPTION_KEY);
    
    // Map key_type to column name
    const columnMap = {
      openai: 'openai_key_encrypted',
      anthropic: 'anthropic_key_encrypted',
      elevenlabs: 'elevenlabs_key_encrypted',
    };
    
    const validColumnMap = {
      openai: 'openai_valid',
      anthropic: 'anthropic_valid',
      elevenlabs: 'elevenlabs_valid',
    };
    
    const validatedAtColumnMap = {
      openai: 'openai_validated_at',
      anthropic: 'anthropic_validated_at',
      elevenlabs: 'elevenlabs_validated_at',
    };
    
    const column = columnMap[body.key_type];
    const validColumn = validColumnMap[body.key_type];
    const validatedAtColumn = validatedAtColumnMap[body.key_type];
    
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Check if user already has a row
    const existingResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}&select=id`,
      { headers }
    );
    
    const existing = await existingResponse.json() as Array<{ id: string }>;
    
    const updateData: Record<string, unknown> = {
      [column]: encryptedKey,
      [validColumn]: true,  // Mark as valid since user just provided it
      [validatedAtColumn]: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    if (existing.length > 0) {
      // Update existing row
      const updateResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}`,
        {
          method: "PATCH",
          headers: { ...headers, "Prefer": "return=representation" },
          body: JSON.stringify(updateData),
        }
      );
      
      if (!updateResponse.ok) {
        const err = await updateResponse.text();
        return json({ error: `Failed to update key: ${err}` }, 500);
      }
      
      return json({ success: true, action: "updated" });
    } else {
      // Insert new row
      const insertData = {
        user_id: userId,
        ...updateData,
      };
      
      const insertResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/user_api_keys`,
        {
          method: "POST",
          headers: { ...headers, "Prefer": "return=representation" },
          body: JSON.stringify(insertData),
        }
      );
      
      if (!insertResponse.ok) {
        const err = await insertResponse.text();
        return json({ error: `Failed to save key: ${err}` }, 500);
      }
      
      return json({ success: true, action: "created" });
    }
    
  } catch (error) {
    console.error("[SaveUserKey] Error:", error);
    return json({ 
      error: error instanceof Error ? error.message : "Failed to save key" 
    }, 500);
  }
}

// TTS now handled by Modal - see modal/transcribe.py
