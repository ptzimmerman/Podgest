import { getUserApiKeys, validateOpenAIKey, validateAnthropicKey, validateElevenLabsKey, validateOpenAIKeyDetailed, validateAnthropicKeyDetailed, validateElevenLabsKeyDetailed } from './user-keys';
import { generateChunkedEmbeddings } from './embeddings';
import { encryptApiKey, decryptApiKey } from './encryption';

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
  // Cloudflare Queue for async digest processing
  DIGEST_QUEUE: Queue<DigestQueueMessage>;
  // Admin API key for protecting admin/test/debug endpoints
  // Generate with: openssl rand -hex 32
  // Set with: wrangler secret put ADMIN_API_KEY
  ADMIN_API_KEY: string;
}

// Queue message type for async digest processing
interface DigestQueueMessage {
  user_id: string;
  triggered_at: string;
  run_id: string;
}
// Note: Inngest removed - now using Supabase pg_cron for scheduling

/**
 * Simple per-user rate limiter for expensive endpoints.
 * Tracks timestamps of recent calls per user. Resets on worker restart.
 * This is best-effort protection - not a substitute for proper rate limiting
 * at the edge, but prevents casual abuse of costly AI API calls.
 */
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(userId: string, maxCalls: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  
  // Remove timestamps outside the window
  const recent = timestamps.filter(t => now - t < windowMs);
  
  if (recent.length >= maxCalls) {
    rateLimitMap.set(userId, recent);
    return false; // Rate limited
  }
  
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return true; // Allowed
}

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
// PUBLICATION FREQUENCY CALCULATION
// ============================================

// Calculate average days between episodes from a list of episode dates
function calculatePublicationFrequency(episodeDates: Date[]): number | null {
  if (episodeDates.length < 2) return null;
  
  // Sort dates descending (newest first)
  const sorted = [...episodeDates].sort((a, b) => b.getTime() - a.getTime());
  
  // Take up to last 20 episodes for calculation (to avoid old data skewing results)
  const recent = sorted.slice(0, 20);
  
  if (recent.length < 2) return null;
  
  // Calculate intervals between consecutive episodes
  const intervals: number[] = [];
  for (let i = 0; i < recent.length - 1; i++) {
    const daysBetween = (recent[i].getTime() - recent[i + 1].getTime()) / (1000 * 60 * 60 * 24);
    intervals.push(daysBetween);
  }
  
  // Average interval
  const avgDays = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  
  // Round to 1 decimal place
  return Math.round(avgDays * 10) / 10;
}

// Calculate frequency from RSS feed XML
function calculateFrequencyFromRSS(episodes: Array<{ published_at: string | Date | null }>): number | null {
  const dates = episodes
    .map(ep => ep.published_at ? new Date(ep.published_at) : null)
    .filter((d): d is Date => d !== null && !isNaN(d.getTime()));
  
  return calculatePublicationFrequency(dates);
}

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
  
  // Check for common non-RSS URL patterns
  if (feedUrl.includes('embed.podcasts.apple.com') || feedUrl.includes('podcasts.apple.com/us/podcast')) {
    throw new Error('This is an Apple Podcasts link, not an RSS feed. Please find the podcast\'s RSS feed URL instead.');
  }
  if (feedUrl.includes('open.spotify.com') || feedUrl.includes('spotify.com/show')) {
    throw new Error('This is a Spotify link, not an RSS feed. Please find the podcast\'s RSS feed URL instead.');
  }
  if (feedUrl.includes('youtube.com') || feedUrl.includes('youtu.be')) {
    throw new Error('This is a YouTube link, not an RSS feed. Please find the podcast\'s RSS feed URL instead.');
  }
  
  const response = await fetch(feedUrl, {
    headers: { "User-Agent": "Podgest/1.0 (podcast aggregator)" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed: ${response.status}`);
  }

  const xml = await response.text();
  
  // Check if it's actually XML/RSS content
  const trimmedXml = xml.trim();
  if (trimmedXml.startsWith('<!DOCTYPE html') || trimmedXml.startsWith('<html') || trimmedXml.includes('<head>') && !trimmedXml.includes('<rss')) {
    throw new Error('This URL returns HTML, not an RSS feed. Please find the podcast\'s direct RSS feed URL.');
  }
  
  if (!trimmedXml.includes('<rss') && !trimmedXml.includes('<feed') && !trimmedXml.includes('<channel')) {
    throw new Error('This URL does not appear to be a valid RSS feed.');
  }
  
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
      
      // Calculate publication frequency from episode dates
      const publicationFrequency = calculateFrequencyFromRSS(feed.episodes);
      
      // Update subscription metadata including frequency
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/subscriptions?id=eq.${sub.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            artwork_url: feed.artwork_url,
            last_polled_at: new Date().toISOString(),
            publication_frequency_days: publicationFrequency,
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
                  webhook_url: "https://api.podgest.app/api/webhooks/modal",
                  admin_key: env.ADMIN_API_KEY,
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

/**
 * Verify that a request carries a valid admin API key.
 * The key must be sent as `Authorization: Bearer <ADMIN_API_KEY>`
 * or as `X-Admin-Key: <ADMIN_API_KEY>`.
 * Returns null if authorized, or an error Response if not.
 */
function requireAdminAuth(request: Request, env: Env): Response | null {
  // Check X-Admin-Key header first
  const adminKeyHeader = request.headers.get('X-Admin-Key');
  if (adminKeyHeader && adminKeyHeader === env.ADMIN_API_KEY) {
    return null; // authorized
  }

  // Fall back to Authorization: Bearer <admin_key>
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    if (token === env.ADMIN_API_KEY) {
      return null; // authorized
    }
  }

  return json({ error: "Unauthorized: valid admin key required" }, 401);
}

/**
 * Verify a Supabase JWT token by calling the Supabase Auth API.
 * Returns the user's ID if valid, or null if invalid/expired.
 */
async function verifySupabaseJWT(request: Request, env: Env): Promise<{ userId: string } | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  
  const token = authHeader.replace('Bearer ', '');
  
  // Don't try to verify the admin key as a JWT
  if (token === env.ADMIN_API_KEY) return null;
  
  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    
    if (!response.ok) return null;
    
    const user = await response.json() as { id: string };
    if (!user?.id) return null;
    
    return { userId: user.id };
  } catch {
    return null;
  }
}

/**
 * Require either admin API key OR valid user JWT.
 * For user-facing endpoints that should work from the frontend (with JWT)
 * and from admin/backend calls (with admin key).
 * Returns the authenticated user ID, or an error Response.
 */
async function requireAuth(request: Request, env: Env): Promise<{ userId: string } | Response> {
  // Check admin key first (cheap, synchronous check)
  const adminAuth = requireAdminAuth(request, env);
  if (adminAuth === null) {
    // Admin key valid - extract user_id from body if present
    try {
      const cloned = request.clone();
      const body = await cloned.json() as { user_id?: string };
      if (body?.user_id) {
        return { userId: body.user_id };
      }
    } catch { /* no body or not JSON */ }
    return { userId: 'admin' };
  }
  
  // Try JWT verification
  const jwtAuth = await verifySupabaseJWT(request, env);
  if (jwtAuth) return jwtAuth;
  
  return json({ error: "Unauthorized: valid credentials required" }, 401);
}

/**
 * Validate that a string is a valid UUID v4 format.
 * Prevents PostgREST filter injection when interpolating into query strings.
 */
function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Validate that a URL belongs to our Supabase Storage domain.
 * Prevents content injection via webhook audio_url spoofing.
 */
function isAllowedAudioUrl(audioUrl: string, env: Env): boolean {
  try {
    const url = new URL(audioUrl);
    const supabaseUrl = new URL(env.SUPABASE_URL);
    return url.hostname === supabaseUrl.hostname;
  } catch {
    return false;
  }
}

// Allowed CORS origins for browser requests
const ALLOWED_ORIGINS = [
  "https://dash.podgest.app",
  "https://podgest.app",
  "http://localhost:5173",    // Local dev
  "http://localhost:3000",    // Local dev
];

// Get CORS headers for a specific request origin
function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
    "Vary": "Origin",
  };
}

// Helper to add CORS headers to response
function withCors(response: Response, request?: Request): Response {
  const newHeaders = new Headers(response.headers);
  const corsHeaders = request ? getCorsHeaders(request) : {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
    "Vary": "Origin",
  };
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
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Manual poll trigger (admin only)
    if (url.pathname === "/api/poll" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      try {
        const result = await pollAllSubscriptions(env);
        return json(result);
      } catch (error) {
        console.error("[Poll] Error:", error);
        return json({ error: "Poll failed" }, 500);
      }
    }

    // Modal transcription webhook (admin key required)
    if (url.pathname === "/api/webhooks/modal" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleModalWebhook(request, env, ctx);
    }
    
    // Modal TTS webhook (admin key required)
    if (url.pathname === "/api/webhooks/tts" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleTTSWebhook(request, env);
    }
    
    // Manual topic extraction trigger (admin only)
    if (url.pathname === "/api/extract-topics" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleExtractTopics(request, env);
    }
    
    // Manual SuperMemory embedding trigger (admin only)
    if (url.pathname === "/api/embed-content" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleEmbedContent(request, env);
    }
    
    // Generate digest (user JWT or admin key)
    if (url.pathname === "/api/generate-digest" && request.method === "POST") {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      
      // Rate limit: max 3 digest generations per user per hour (costs ~$0.10-0.50 each in AI API calls)
      // Admin key bypasses rate limit for cron/automated calls
      const isAdminCall = requireAdminAuth(request, env) === null;
      if (!isAdminCall) {
        const rateLimitUserId = 'userId' in auth ? auth.userId : 'unknown';
        if (!checkRateLimit(`digest:${rateLimitUserId}`, 3, 60 * 60 * 1000)) {
          return json({ error: "Rate limited: max 3 digest generations per hour" }, 429);
        }
      }
      
      return handleGenerateDigest(request, env, ctx);
    }
    
    // Scheduled digest generation (admin only - called by pg_cron via /api/daily-cron)
    if (url.pathname === "/api/scheduled-digest" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleScheduledDigest(env);
    }
    
    // RSS feed for Spotify (support both GET and HEAD for podcast apps)
    if (url.pathname.startsWith("/feed/") && (request.method === "GET" || request.method === "HEAD")) {
      const userId = url.pathname.replace("/feed/", "").replace(".xml", "");
      if (!isValidUUID(userId)) {
        return json({ error: "Invalid feed ID" }, 400);
      }
      const baseUrl = `${url.protocol}//${url.host}`;
      
      // Check if request is from a social media crawler (for rich link previews)
      const userAgent = request.headers.get("User-Agent") || "";
      const isCrawler = /facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|TelegramBot|WhatsApp|Discordbot|iMessageLinkBot/i.test(userAgent);
      
      if (isCrawler) {
        // Return HTML with OG tags for social media previews
        return handleFeedOGPreview(userId, env, baseUrl);
      }
      
      const response = await handleRSSFeed(userId, env, baseUrl);
      // For HEAD requests, return empty body but same headers
      if (request.method === "HEAD") {
        return new Response(null, {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    }
    
    // Re-embed all transcriptions in SuperMemory (admin only)
    // Use ?offset=N&limit=M to paginate
    if (url.pathname === "/api/reembed-all" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleReembedAll(env, request);
    }
    
    // Admin endpoint to update user profile settings (admin only)
    if (url.pathname === "/api/admin/update-profile" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleUpdateProfile(request, env);
    }
    
    // ============================================
    // ADMIN USER MANAGEMENT ENDPOINTS (all require admin auth)
    // ============================================
    
    // List all users with status
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleAdminListUsers(env);
    }
    
    // Deactivate user (soft delete - disables subscriptions, keeps data)
    if (url.pathname.startsWith("/api/admin/deactivate-user/") && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const userId = url.pathname.replace("/api/admin/deactivate-user/", "");
      return handleAdminDeactivateUser(userId, env);
    }
    
    // Reactivate user (re-enables subscriptions)
    if (url.pathname.startsWith("/api/admin/reactivate-user/") && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const userId = url.pathname.replace("/api/admin/reactivate-user/", "");
      return handleAdminReactivateUser(userId, env);
    }
    
    // Delete user (hard delete - removes all user data)
    if (url.pathname.startsWith("/api/admin/delete-user/") && request.method === "DELETE") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const userId = url.pathname.replace("/api/admin/delete-user/", "");
      return handleAdminDeleteUser(userId, env);
    }
    
    // ElevenReader transcript (admin only - exposes user data)
    // URL: /transcript/latest or /transcript/{userId}
    if (url.pathname.startsWith("/transcript/")) {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleLatestTranscript(url.pathname, env);
    }
    
    // Debug endpoint to check timezone calculation (admin only)
    if (url.pathname === "/api/debug-cron" && request.method === "GET") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
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
    
    // Daily cron trigger (admin only - called by Supabase pg_cron or external scheduler)
    // This runs the full daily workflow: poll + digest
    if (url.pathname === "/api/daily-cron" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleDailyCron(env, ctx);
    }
    
    // Pipeline observability - view recent runs (admin only)
    if (url.pathname === "/api/pipeline/runs" && request.method === "GET") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handlePipelineRuns(env, url);
    }
    
    // Pipeline observability - view logs for a specific run (admin only)
    if (url.pathname.startsWith("/api/pipeline/run/") && request.method === "GET") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const runId = url.pathname.replace("/api/pipeline/run/", "");
      return handlePipelineRunLogs(env, runId);
    }
    
    // BYOK: Validate API key (for Settings UI)
    if (url.pathname === "/api/validate-key" && request.method === "POST") {
      return withCors(await handleValidateKey(request), request);
    }
    
    // BYOK: Save user API keys
    if (url.pathname === "/api/user-keys" && request.method === "POST") {
      return withCors(await handleSaveUserKey(request, env), request);
    }
    
    // Generate welcome episode for new user
    if (url.pathname === "/api/generate-welcome" && request.method === "POST") {
      return withCors(await handleGenerateWelcome(request, env, ctx), request);
    }
    
    // Async queue: Dispatch all users (admin only)
    if (url.pathname === "/api/dispatch" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleDispatcher(env);
    }
    
    // Async queue: Re-queue specific users (admin only)
    if (url.pathname === "/api/requeue-users" && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleRequeueUsers(request, env);
    }
    
    // Async queue: Queue status check (admin only)
    if (url.pathname === "/api/queue/status" && request.method === "GET") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      return handleQueueStatus(env);
    }
    
    // Test endpoint: Check API key status for a user (admin only)
    if (url.pathname.startsWith("/api/test/key-status/") && request.method === "GET") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const userId = url.pathname.replace("/api/test/key-status/", "");
      return handleTestKeyStatus(env, userId);
    }
    
    // Test endpoint: Delete today's digest for a user (admin only)
    if (url.pathname.startsWith("/api/test/delete-digest/") && request.method === "DELETE") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const userId = url.pathname.replace("/api/test/delete-digest/", "");
      return handleTestDeleteDigest(env, userId);
    }
    
    // Test endpoint: Force generate digest for a user (admin only)
    if (url.pathname.startsWith("/api/test/force-digest/") && request.method === "POST") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const userId = url.pathname.replace("/api/test/force-digest/", "");
      // Create a request with force=true
      const forceRequest = new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, hours_back: 168, force: true }),  // 7 days
      });
      return handleGenerateDigest(forceRequest, env, ctx);
    }
    
    // Debug endpoint: Show user's subscriptions and available episodes (admin only)
    if (url.pathname.startsWith("/api/test/debug-episodes/") && request.method === "GET") {
      const authError = requireAdminAuth(request, env);
      if (authError) return authError;
      const userId = url.pathname.replace("/api/test/debug-episodes/", "");
      return handleDebugEpisodes(env, userId);
    }
    
    // Parse feed endpoint: Analyzes RSS feed and detects ListenNotes aggregator
    // Returns feed info, detected podcasts (if aggregator), and frequency data
    if (url.pathname === "/api/parse-feed" && request.method === "POST") {
      return withCors(await handleParseFeed(request, env), request);
    }

    return json({ error: "Not found" }, 404);
  },
  
  // Queue consumer for async digest processing
  // Each message = one user's digest job with independent timeout/retry
  async queue(batch: MessageBatch<DigestQueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
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

/** Escape HTML special characters to prevent XSS in dynamic HTML output */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
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

    // Validate episode_id is a proper UUID to prevent PostgREST filter injection
    if (!isValidUUID(jobData.episode_id)) {
      return json({ error: "Invalid episode_id format" }, 400);
    }

    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    };

    // State check: verify the transcription exists and is in "processing" state
    const checkResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${jobData.episode_id}&select=episode_id,status`,
      { headers }
    );
    if (checkResponse.ok) {
      const existing = await checkResponse.json() as Array<{ episode_id: string; status: string }>;
      if (!existing.length) {
        console.warn(`[Webhook] No transcription found for episode: ${jobData.episode_id}`);
        return json({ error: "Transcription record not found" }, 404);
      }
      if (existing[0].status === "completed") {
        console.warn(`[Webhook] Transcription for ${jobData.episode_id} already completed - ignoring duplicate`);
        return json({ error: "Already completed" }, 409);
      }
    }

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

    // Validate digest_id is a proper UUID to prevent PostgREST filter injection
    if (!isValidUUID(payload.digest_id)) {
      return json({ error: "Invalid digest_id format" }, 400);
    }

    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    };

    // State check: only accept webhooks for digests currently in "generating" state
    const checkResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?id=eq.${payload.digest_id}&select=id,status`,
      { headers }
    );
    if (checkResponse.ok) {
      const existing = await checkResponse.json() as Array<{ id: string; status: string }>;
      if (!existing.length) {
        console.warn(`[TTS Webhook] No digest found for id: ${payload.digest_id}`);
        return json({ error: "Digest not found" }, 404);
      }
      if (existing[0].status !== "generating") {
        console.warn(`[TTS Webhook] Digest ${payload.digest_id} is in state '${existing[0].status}', not 'generating' - ignoring`);
        return json({ error: "Digest not in generating state" }, 409);
      }
    }

    if (payload.status === "completed" && payload.audio_url) {
      // Validate audio_url domain - only accept URLs from our Supabase Storage
      if (!isAllowedAudioUrl(payload.audio_url, env)) {
        console.error(`[TTS Webhook] Rejected audio_url from untrusted domain: ${payload.audio_url}`);
        return json({ error: "Untrusted audio_url domain" }, 400);
      }

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
    // Verify JWT token via Supabase Auth
    const auth = await verifySupabaseJWT(request, env);
    if (!auth) {
      return json({ error: "Unauthorized: invalid or expired token" }, 401);
    }
    const userId = auth.userId;
    
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
            webhook_url: "https://api.podgest.app/api/webhooks/tts",
            admin_key: env.ADMIN_API_KEY,
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
    
    // 2. Find ALL users subscribed to this feed (not just one!)
    const subResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?feed_url=eq.${encodeURIComponent(episodes[0].feed_url)}&select=user_id`,
      { headers }
    );
    
    const subs = await subResponse.json() as Array<{ user_id: string }>;
    
    if (!subs.length) {
      console.log(`[Embeddings] No users subscribed to this feed, skipping pgvector embedding`);
      return;
    }
    
    console.log(`[Embeddings] Found ${subs.length} users subscribed to this feed`);
    
    // 3. Get transcription ID (shared across all users)
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
    
    // 4. Generate embeddings ONCE using first user's key, then store for ALL users
    // Find a user with a valid OpenAI key
    let openaiKey: string | undefined;
    let keyUserId: string | undefined;
    
    for (const sub of subs) {
      try {
        const userKeys = await getUserApiKeys(
          env.SUPABASE_URL,
          env.SUPABASE_SERVICE_ROLE_KEY,
          sub.user_id,
          env.API_KEY_ENCRYPTION_KEY
        );
        
        if (userKeys.openaiKey) {
          openaiKey = userKeys.openaiKey;
          keyUserId = sub.user_id;
          break;
        }
      } catch (keyError) {
        console.log(`[Embeddings] Failed to get key for user ${sub.user_id}: ${keyError}`);
      }
    }
    
    if (!openaiKey) {
      console.error(`[Embeddings] No users have OpenAI key configured, skipping embeddings`);
      return;
    }
    
    console.log(`[Embeddings] Using OpenAI key from user ${keyUserId} to generate embeddings`);
    
    // 5. Generate chunked embeddings (once)
    console.log(`[Embeddings] Generating embeddings for transcript (${transcriptText.length} chars)...`);
    const chunkedEmbeddings = await generateChunkedEmbeddings(transcriptText, openaiKey);
    
    console.log(`[Embeddings] Generated ${chunkedEmbeddings.length} chunks for episode ${episodeId}`);
    
    // 6. Store embeddings for EACH subscribed user
    for (const sub of subs) {
      console.log(`[Embeddings] Storing embeddings for user ${sub.user_id}...`);
      
      for (const chunk of chunkedEmbeddings) {
        const insertResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/transcript_embeddings`,
          {
            method: "POST",
            headers: { ...headers, "Prefer": "return=minimal" },
            body: JSON.stringify({
              user_id: sub.user_id,
              episode_id: episodeId,
              chunk_index: chunk.chunkIndex,
              chunk_text: chunk.chunkText,
              word_count: chunk.wordCount,
              embedding: JSON.stringify(chunk.embedding), // pgvector expects array as string
            }),
          }
        );
        
        if (!insertResponse.ok) {
          const err = await insertResponse.text();
          // Ignore duplicate key errors (user already has this embedding)
          if (!err.includes('duplicate')) {
            console.error(`[Embeddings] Failed to insert chunk ${chunk.chunkIndex} for user ${sub.user_id}: ${err}`);
          }
        }
      }
      
      console.log(`[Embeddings] ✅ Stored ${chunkedEmbeddings.length} embeddings for user ${sub.user_id}`);
    }
    
    console.log(`[Embeddings] ✅ Completed embeddings for ${subs.length} users on episode ${episodeId}`);
    
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
      console.error("[UpdateProfile] Supabase error:", error);
      return json({ error: "Failed to update profile" }, 500);
    }
    
    const updated = await response.json();
    return json({ success: true, profile: updated });
    
  } catch (error) {
    console.error("[UpdateProfile] Error:", error);
    return json({ error: "Failed to update profile" }, 500);
  }
}

// ============================================
// ADMIN USER MANAGEMENT HANDLERS
// ============================================

// List all users with their status
async function handleAdminListUsers(env: Env): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get all profiles
    const profilesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?select=id,email,display_name,timezone,created_at`,
      { headers }
    );
    
    if (!profilesResponse.ok) {
      return json({ error: "Failed to fetch profiles" }, 500);
    }
    
    const profiles = await profilesResponse.json() as Array<{
      id: string;
      email: string;
      display_name: string | null;
      timezone: string;
      created_at: string;
    }>;
    
    // Get subscription counts and status for each user
    const users = await Promise.all(profiles.map(async (profile) => {
      const subsResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${profile.id}&select=id,is_active`,
        { headers }
      );
      const subs = await subsResponse.json() as Array<{ id: string; is_active: boolean }>;
      
      const digestsResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${profile.id}&select=id&limit=1&order=created_at.desc`,
        { headers }
      );
      const digests = await digestsResponse.json() as Array<{ id: string }>;
      
      const apiKeysResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${profile.id}&select=anthropic_key_encrypted,openai_key_encrypted`,
        { headers }
      );
      const apiKeys = await apiKeysResponse.json() as Array<{ anthropic_key_encrypted: string | null; openai_key_encrypted: string | null }>;
      
      const activeSubs = subs.filter(s => s.is_active).length;
      const totalSubs = subs.length;
      const hasApiKeys = apiKeys.length > 0 && !!(apiKeys[0].anthropic_key_encrypted || apiKeys[0].openai_key_encrypted);
      
      return {
        id: profile.id,
        email: profile.email,
        display_name: profile.display_name,
        timezone: profile.timezone,
        created_at: profile.created_at,
        status: activeSubs > 0 ? "active" : (totalSubs > 0 ? "deactivated" : "no_subscriptions"),
        subscriptions: { active: activeSubs, total: totalSubs },
        has_digests: digests.length > 0,
        has_api_keys: hasApiKeys,
      };
    }));
    
    return json({ users, count: users.length });
    
  } catch (error) {
    console.error("[AdminListUsers] Error:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// Deactivate user - soft delete (disables subscriptions, keeps all data)
async function handleAdminDeactivateUser(userId: string, env: Env): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
  
  try {
    // Get user info first
    const profileResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=email`,
      { headers }
    );
    const profiles = await profileResponse.json() as Array<{ email: string }>;
    
    if (profiles.length === 0) {
      return json({ error: "User not found" }, 404);
    }
    
    // Deactivate all subscriptions
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ is_active: false }),
      }
    );
    
    if (!response.ok) {
      console.error("[AdminDeactivateUser] Error:", await response.text());
      return json({ error: "Failed to deactivate subscriptions" }, 500);
    }
    
    const deactivated = await response.json() as unknown[];
    
    return json({
      success: true,
      action: "deactivated",
      user_id: userId,
      email: profiles[0].email,
      subscriptions_deactivated: deactivated.length,
      message: "User deactivated. All subscriptions disabled. Data preserved.",
    });
    
  } catch (error) {
    console.error("[AdminDeactivateUser] Error:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// Reactivate user - re-enables subscriptions
async function handleAdminReactivateUser(userId: string, env: Env): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
  
  try {
    // Get user info first
    const profileResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=email`,
      { headers }
    );
    const profiles = await profileResponse.json() as Array<{ email: string }>;
    
    if (profiles.length === 0) {
      return json({ error: "User not found" }, 404);
    }
    
    // Reactivate all subscriptions
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ is_active: true }),
      }
    );
    
    if (!response.ok) {
      console.error("[AdminReactivateUser] Error:", await response.text());
      return json({ error: "Failed to reactivate subscriptions" }, 500);
    }
    
    const reactivated = await response.json() as unknown[];
    
    return json({
      success: true,
      action: "reactivated",
      user_id: userId,
      email: profiles[0].email,
      subscriptions_reactivated: reactivated.length,
      message: "User reactivated. All subscriptions enabled.",
    });
    
  } catch (error) {
    console.error("[AdminReactivateUser] Error:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// Delete user - hard delete (removes all user data permanently)
async function handleAdminDeleteUser(userId: string, env: Env): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get user info first
    const profileResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=email`,
      { headers }
    );
    const profiles = await profileResponse.json() as Array<{ email: string }>;
    
    if (profiles.length === 0) {
      return json({ error: "User not found" }, 404);
    }
    
    const email = profiles[0].email;
    const deletionLog: string[] = [];
    
    // 1. Get digest IDs to delete storage files
    const digestsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&select=id`,
      { headers }
    );
    const digests = await digestsResponse.json() as Array<{ id: string }>;
    
    // 2. Delete digest audio files from storage
    for (const digest of digests) {
      try {
        await fetch(
          `${env.SUPABASE_URL}/storage/v1/object/digests/${digest.id}/digest.mp3`,
          { method: "DELETE", headers }
        );
      } catch {
        // Storage deletion failures are non-fatal
      }
    }
    deletionLog.push(`Deleted ${digests.length} digest audio files from storage`);
    
    // 3. Delete user_api_keys
    const apiKeysResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}`,
      { method: "DELETE", headers }
    );
    if (apiKeysResponse.ok) {
      deletionLog.push("Deleted user API keys");
    }
    
    // 4. Delete digests
    const digestDeleteResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}`,
      { method: "DELETE", headers }
    );
    if (digestDeleteResponse.ok) {
      deletionLog.push(`Deleted ${digests.length} digests`);
    }
    
    // 5. Delete subscriptions
    const subsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      { method: "DELETE", headers }
    );
    if (subsResponse.ok) {
      deletionLog.push("Deleted subscriptions");
    }
    
    // 6. Delete profile (this removes the user from our system)
    const profileDeleteResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
      { method: "DELETE", headers }
    );
    if (profileDeleteResponse.ok) {
      deletionLog.push("Deleted user profile");
    }
    
    // Note: auth.users record remains (managed by Supabase Auth)
    // To fully delete the auth user, use Supabase Dashboard or Admin API
    
    return json({
      success: true,
      action: "deleted",
      user_id: userId,
      email: email,
      deletion_log: deletionLog,
      message: "User data deleted. Note: auth.users record may remain (delete via Supabase Dashboard if needed).",
    });
    
  } catch (error) {
    console.error("[AdminDeleteUser] Error:", error);
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

// ============================================
// ASYNC QUEUE ARCHITECTURE
// ============================================
// The async queue system decouples cron triggering from processing:
// 1. Dispatcher (fast, <1s): Queries users, pushes one message per user to queue
// 2. Consumer (per-user, 30s each): Processes polling + digest for one user
// This eliminates timeout issues when processing many users/feeds

// Log pipeline event with user context for debugging
async function logPipelineEvent(
  env: Env,
  userId: string | null,
  eventType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    // Include user_id in details since pipeline_logs doesn't have a user_id column
    const details = {
      ...metadata,
      user_id: userId,
    };
    
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
          run_id: metadata.run_id || crypto.randomUUID(),
          step: eventType,
          status: metadata.status || 'completed',
          details: details,
          error: metadata.error || null,
        }),
      }
    );
  } catch (e) {
    console.error(`[PipelineEvent] Failed to log ${eventType}:`, e);
  }
}

// Dispatcher: Fast function that just queues users (called by cron)
// This returns in <1 second, avoiding any timeout issues
async function handleDispatcher(env: Env): Promise<Response> {
  const runId = crypto.randomUUID();
  const startTime = Date.now();
  
  console.log(`[Dispatcher] Starting dispatch, run_id=${runId}`);
  await logPipelineEvent(env, null, 'dispatcher_started', {
    run_id: runId,
    triggered_at: new Date().toISOString(),
  });
  
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get all active users
    const profilesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?select=id,email,timezone`,
      { headers }
    );
    
    if (!profilesResponse.ok) {
      throw new Error("Failed to fetch profiles");
    }
    
    const profiles = await profilesResponse.json() as Array<{
      id: string;
      email: string;
      timezone: string;
    }>;
    
    console.log(`[Dispatcher] Found ${profiles.length} users to queue`);
    
    // Queue one message per user
    const queuedUsers: string[] = [];
    for (const profile of profiles) {
      const message: DigestQueueMessage = {
        user_id: profile.id,
        triggered_at: new Date().toISOString(),
        run_id: runId,
      };
      
      await env.DIGEST_QUEUE.send(message);
      queuedUsers.push(profile.id);
      
      await logPipelineEvent(env, profile.id, 'dispatcher_queued_user', {
        run_id: runId,
        email: profile.email,
        timezone: profile.timezone,
      });
      
      console.log(`[Dispatcher] Queued user ${profile.id} (${profile.email})`);
    }
    
    const duration = Date.now() - startTime;
    await logPipelineEvent(env, null, 'dispatcher_completed', {
      run_id: runId,
      users_queued: profiles.length,
      duration_ms: duration,
    });
    
    console.log(`[Dispatcher] Completed in ${duration}ms, queued ${profiles.length} users`);
    
    return json({
      success: true,
      status: "dispatched",
      run_id: runId,
      users_queued: profiles.length,
      duration_ms: duration,
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Dispatcher] Error: ${errorMsg}`);
    
    await logPipelineEvent(env, null, 'dispatcher_error', {
      run_id: runId,
      error: errorMsg,
      status: 'failed',
    });
    
    return json({
      success: false,
      error: errorMsg,
      run_id: runId,
    }, 500);
  }
}

// Poll subscriptions for a single user (used by queue consumer)
async function pollSubscriptionsForUser(
  env: Env,
  userId: string,
  runId: string
): Promise<{
  subscriptions_polled: number;
  new_episodes: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let newEpisodesTotal = 0;
  
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  await logPipelineEvent(env, userId, 'polling_started', { run_id: runId });
  
  // Get user's subscriptions
  const subscriptionsResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&is_active=eq.true&select=id,feed_url,podcast_title`,
    { headers }
  );
  
  if (!subscriptionsResponse.ok) {
    const errorBody = await subscriptionsResponse.text();
    throw new Error(`Failed to fetch user subscriptions: ${subscriptionsResponse.status} - ${errorBody}`);
  }
  
  const subscriptions = await subscriptionsResponse.json() as Array<{
    id: string;
    feed_url: string;
    podcast_title: string;
  }>;
  
  console.log(`[Poll-${userId.slice(0,8)}] Polling ${subscriptions.length} subscriptions`);
  
  for (const sub of subscriptions) {
    try {
      // Parse RSS feed
      const feedResponse = await fetch(sub.feed_url, {
        headers: { "User-Agent": "Podgest/1.0 (RSS Reader)" },
      });
      
      if (!feedResponse.ok) {
        errors.push(`${sub.podcast_title}: HTTP ${feedResponse.status}`);
        await logPipelineEvent(env, userId, 'polling_feed_error', {
          run_id: runId,
          subscription_id: sub.id,
          feed_name: sub.podcast_title,
          error: `HTTP ${feedResponse.status}`,
        });
        continue;
      }
      
      const feedText = await feedResponse.text();
      
      // Simple RSS parsing to extract items
      const items: Array<{
        title: string;
        guid: string;
        pubDate: string;
        enclosure?: string;
        description?: string;
      }> = [];
      
      const itemMatches = feedText.match(/<item>[\s\S]*?<\/item>/gi) || [];
      console.log(`[Poll-${userId.slice(0,8)}] Found ${itemMatches.length} items in ${sub.podcast_title} feed`);
      for (const itemXml of itemMatches.slice(0, 10)) { // Latest 10 only
        const title = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() || "";
        const guid = itemXml.match(/<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/i)?.[1]?.trim() || 
                     itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1]?.trim() || "";
        const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() || "";
        // Match both single and double quotes for enclosure URL (consistent with parseRSSFeed)
        const enclosure = itemXml.match(/<enclosure[^>]*url=["']([^"']+)["']/i)?.[1] || "";
        const description = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim() || "";
        
        if (guid && title) {
          items.push({ title, guid, pubDate, enclosure, description });
        } else {
          console.log(`[Poll-${userId.slice(0,8)}] Skipped item: guid=${!!guid}, title=${!!title}, enclosure=${!!enclosure}`);
        }
      }
      
      console.log(`[Poll-${userId.slice(0,8)}] Parsed ${items.length} valid items with guid+title`);
      
      // Check which episodes are new
      for (const item of items) {
        // Check if episode exists for THIS feed_url (not globally by guid)
        // This allows the same episode content to exist in multiple feeds (e.g., direct subscription vs ListenNotes aggregator)
        const existingResponse = await fetch(
          `${env.SUPABASE_URL}/rest/v1/episodes?guid=eq.${encodeURIComponent(item.guid)}&feed_url=eq.${encodeURIComponent(sub.feed_url)}&select=id`,
          { headers }
        );
        
        const existing = await existingResponse.json() as Array<{ id: string }>;
        
        if (existing.length === 0 && item.enclosure) {
          // Check exclusion list
          if (shouldExcludeEpisode(item.title, item.description || "")) {
            console.log(`[Poll-${userId.slice(0,8)}] Skipping excluded episode: ${item.title}`);
            continue;
          }
          
          // Insert new episode
          const insertResponse = await fetch(
            `${env.SUPABASE_URL}/rest/v1/episodes`,
            {
              method: "POST",
              headers: { ...headers, "Prefer": "return=representation" },
              body: JSON.stringify({
                feed_url: sub.feed_url,  // Use feed_url to match subscription
                title: item.title,
                guid: item.guid,
                audio_url: item.enclosure,
                published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                description: item.description || null,
              }),
            }
          );
          
          if (insertResponse.ok) {
            newEpisodesTotal++;
            console.log(`[Poll-${userId.slice(0,8)}] New episode: ${item.title}`);
          }
        }
      }
      
      await logPipelineEvent(env, userId, 'polling_feed_success', {
        run_id: runId,
        subscription_id: sub.id,
        feed_name: sub.podcast_title,
        items_found: items.length,
      });
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`${sub.podcast_title}: ${errorMsg}`);
      await logPipelineEvent(env, userId, 'polling_feed_error', {
        run_id: runId,
        subscription_id: sub.id,
        feed_name: sub.podcast_title,
        error: errorMsg,
      });
    }
  }
  
  await logPipelineEvent(env, userId, 'polling_completed', {
    run_id: runId,
    subscriptions_polled: subscriptions.length,
    new_episodes: newEpisodesTotal,
    errors_count: errors.length,
  });
  
  return {
    subscriptions_polled: subscriptions.length,
    new_episodes: newEpisodesTotal,
    errors,
  };
}

// Process digest for a single user (called by queue consumer)
async function processUserDigest(
  env: Env,
  ctx: ExecutionContext,
  message: DigestQueueMessage
): Promise<void> {
  const { user_id, run_id, triggered_at } = message;
  
  console.log(`[Consumer-${user_id.slice(0,8)}] Processing digest, run_id=${run_id}`);
  
  await logPipelineEvent(env, user_id, 'queue_message_received', {
    run_id,
    triggered_at,
  });
  
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  // Get user's timezone
  const profileResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}&select=timezone`,
    { headers }
  );
  
  if (!profileResponse.ok) {
    throw new Error("Failed to fetch user profile");
  }
  
  const profiles = await profileResponse.json() as Array<{ timezone: string }>;
  if (profiles.length === 0) {
    throw new Error("User not found");
  }
  
  const timezone = profiles[0].timezone || "America/Mexico_City";
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  const today = dateFormatter.format(new Date());
  
  // Step 1: Check if digest already exists for today
  const existingResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${user_id}&digest_date=eq.${today}&select=id`,
    { headers }
  );
  
  const existing = await existingResponse.json() as Array<{ id: string }>;
  
  if (existing.length > 0) {
    console.log(`[Consumer-${user_id.slice(0,8)}] Digest already exists for ${today}, skipping`);
    await logPipelineEvent(env, user_id, 'digest_skipped', {
      run_id,
      reason: 'already_exists',
      today_date: today,
    });
    return;
  }
  
  // Step 2: Poll user's RSS feeds
  console.log(`[Consumer-${user_id.slice(0,8)}] Polling RSS feeds...`);
  const pollResult = await pollSubscriptionsForUser(env, user_id, run_id);
  
  console.log(`[Consumer-${user_id.slice(0,8)}] Poll complete: ${pollResult.new_episodes} new episodes`);
  
  // Step 3: Generate digest
  console.log(`[Consumer-${user_id.slice(0,8)}] Generating digest...`);
  await logPipelineEvent(env, user_id, 'digest_generation_started', {
    run_id,
    today_date: today,
  });
  
  const result = await generateDigestForUser(env, ctx, user_id, 24);
  
  if (result.success) {
    console.log(`[Consumer-${user_id.slice(0,8)}] Digest generated successfully: ${result.digest_id}`);
    await logPipelineEvent(env, user_id, 'digest_published', {
      run_id,
      digest_id: result.digest_id,
      today_date: today,
    });
  } else {
    console.error(`[Consumer-${user_id.slice(0,8)}] Digest generation failed: ${result.error}`);
    await logPipelineEvent(env, user_id, 'digest_generation_failed', {
      run_id,
      error: result.error,
      today_date: today,
      status: 'failed',
    });
    throw new Error(result.error);
  }
}

// Queue consumer handler - called by Cloudflare when messages arrive
async function handleQueueBatch(
  batch: MessageBatch<DigestQueueMessage>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  for (const message of batch.messages) {
    const { user_id, run_id } = message.body;
    
    try {
      await processUserDigest(env, ctx, message.body);
      message.ack();
      
      console.log(`[Queue] Successfully processed message for user ${user_id.slice(0,8)}`);
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Queue] Error processing user ${user_id.slice(0,8)}: ${errorMsg}`);
      
      await logPipelineEvent(env, user_id, 'queue_message_error', {
        run_id,
        attempt: message.attempts,
        error: errorMsg,
        status: 'failed',
      });
      
      if (message.attempts >= 3) {
        // Final failure - will go to dead-letter queue
        await logPipelineEvent(env, user_id, 'queue_message_failed', {
          run_id,
          final_error: errorMsg,
          attempts: message.attempts,
          status: 'failed',
        });
        console.error(`[Queue] Message for user ${user_id.slice(0,8)} failed after ${message.attempts} attempts`);
      }
      
      message.retry();
    }
  }
}

// Re-queue specific users (used by watchdog to retry failed digests)
async function handleRequeueUsers(request: Request, env: Env): Promise<Response> {
  const runId = crypto.randomUUID();
  
  try {
    const body = await request.json() as Array<{ user_id: string; email?: string }>;
    
    if (!Array.isArray(body) || body.length === 0) {
      return json({ error: "Expected array of users with user_id" }, 400);
    }
    
    console.log(`[Requeue] Re-queuing ${body.length} users, run_id=${runId}`);
    
    const queuedUsers: string[] = [];
    for (const user of body) {
      if (!user.user_id) continue;
      
      const message: DigestQueueMessage = {
        user_id: user.user_id,
        triggered_at: new Date().toISOString(),
        run_id: runId,
      };
      
      await env.DIGEST_QUEUE.send(message);
      queuedUsers.push(user.user_id);
      
      await logPipelineEvent(env, user.user_id, 'watchdog_requeued', {
        run_id: runId,
        email: user.email,
      });
      
      console.log(`[Requeue] Queued user ${user.user_id}`);
    }
    
    return json({
      success: true,
      status: "requeued",
      run_id: runId,
      users_queued: queuedUsers.length,
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Requeue] Error: ${errorMsg}`);
    return json({ error: errorMsg, run_id: runId }, 500);
  }
}

// Queue status check - shows recent queue activity
async function handleQueueStatus(env: Env): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get recent pipeline events related to queue
    const logsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/pipeline_logs?step=in.(dispatcher_started,dispatcher_completed,queue_message_received,queue_message_error,queue_message_failed,digest_published,digest_skipped)&order=created_at.desc&limit=50`,
      { headers }
    );
    
    if (!logsResponse.ok) {
      throw new Error("Failed to fetch queue logs");
    }
    
    const logs = await logsResponse.json() as Array<{
      run_id: string;
      step: string;
      status: string;
      user_id: string | null;
      details: Record<string, unknown>;
      created_at: string;
    }>;
    
    // Get today's digest counts
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    const digestsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?digest_date=eq.${today}&select=user_id,status`,
      { headers }
    );
    
    const todayDigests = await digestsResponse.json() as Array<{ user_id: string; status: string }>;
    
    // Get all users to check who's missing a digest
    const profilesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?select=id,email`,
      { headers }
    );
    
    const profiles = await profilesResponse.json() as Array<{ id: string; email: string }>;
    
    const usersWithDigest = new Set(todayDigests.map(d => d.user_id));
    const missingDigests = profiles.filter(p => !usersWithDigest.has(p.id));
    
    return json({
      queue_configured: !!env.DIGEST_QUEUE,
      today_date: today,
      digests_today: todayDigests.length,
      users_total: profiles.length,
      users_missing_digest: missingDigests,
      recent_events: logs.slice(0, 20),
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return json({ error: errorMsg }, 500);
  }
}

// Test endpoint: Check API key status for a user
async function handleTestKeyStatus(env: Env, userId: string): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get user profile
    const profileResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id,email`,
      { headers }
    );
    
    const profiles = await profileResponse.json() as Array<{ id: string; email: string }>;
    
    if (profiles.length === 0) {
      return json({ error: "User not found" }, 404);
    }
    
    // Get API key status (encrypted keys and validation status)
    const keysResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}&select=*`,
      { headers }
    );
    
    const keysRows = await keysResponse.json() as Array<{
      openai_key_encrypted: string | null;
      anthropic_key_encrypted: string | null;
      elevenlabs_key_encrypted: string | null;
      openai_valid: boolean;
      anthropic_valid: boolean;
      elevenlabs_valid: boolean;
    }>;
    
    const hasKeyRow = keysRows.length > 0;
    const keyRow = keysRows[0];
    
    // Try to decrypt keys to verify they work
    let decryptionStatus = { openai: 'not_set', anthropic: 'not_set', elevenlabs: 'not_set' };
    
    if (hasKeyRow) {
      if (keyRow.openai_key_encrypted) {
        try {
          const key = await decryptApiKey(keyRow.openai_key_encrypted, env.API_KEY_ENCRYPTION_KEY);
          decryptionStatus.openai = key ? `decrypted (${key.slice(0, 10)}...)` : 'decrypt_failed';
        } catch (e) {
          decryptionStatus.openai = `decrypt_error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      
      if (keyRow.anthropic_key_encrypted) {
        try {
          const key = await decryptApiKey(keyRow.anthropic_key_encrypted, env.API_KEY_ENCRYPTION_KEY);
          decryptionStatus.anthropic = key ? `decrypted (${key.slice(0, 15)}...)` : 'decrypt_failed';
        } catch (e) {
          decryptionStatus.anthropic = `decrypt_error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      
      if (keyRow.elevenlabs_key_encrypted) {
        try {
          const key = await decryptApiKey(keyRow.elevenlabs_key_encrypted, env.API_KEY_ENCRYPTION_KEY);
          decryptionStatus.elevenlabs = key ? `decrypted (${key.slice(0, 10)}...)` : 'decrypt_failed';
        } catch (e) {
          decryptionStatus.elevenlabs = `decrypt_error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    
    return json({
      user: profiles[0],
      has_key_row: hasKeyRow,
      keys: hasKeyRow ? {
        openai: {
          encrypted_length: keyRow.openai_key_encrypted?.length || 0,
          valid: keyRow.openai_valid,
          decryption: decryptionStatus.openai,
        },
        anthropic: {
          encrypted_length: keyRow.anthropic_key_encrypted?.length || 0,
          valid: keyRow.anthropic_valid,
          decryption: decryptionStatus.anthropic,
        },
        elevenlabs: {
          encrypted_length: keyRow.elevenlabs_key_encrypted?.length || 0,
          valid: keyRow.elevenlabs_valid,
          decryption: decryptionStatus.elevenlabs,
        },
      } : null,
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return json({ error: errorMsg }, 500);
  }
}

// Test endpoint: Delete today's digest for a user
async function handleTestDeleteDigest(env: Env, userId: string): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    
    // Find today's digest for this user
    const findResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&digest_date=eq.${today}&select=id,status`,
      { headers }
    );
    
    const digests = await findResponse.json() as Array<{ id: string; status: string }>;
    
    if (digests.length === 0) {
      return json({ message: "No digest found for today", user_id: userId, date: today });
    }
    
    // Delete the digest
    const deleteResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?id=eq.${digests[0].id}`,
      {
        method: "DELETE",
        headers,
      }
    );
    
    if (!deleteResponse.ok) {
      return json({ error: "Failed to delete digest" }, 500);
    }
    
    return json({
      message: "Digest deleted",
      user_id: userId,
      date: today,
      deleted_digest: digests[0],
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return json({ error: errorMsg }, 500);
  }
}

// Debug endpoint: Show user's subscriptions and available episodes
async function handleDebugEpisodes(env: Env, userId: string): Promise<Response> {
  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  
  try {
    // Get user's subscriptions
    const subsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&is_active=eq.true&select=id,feed_url,podcast_title`,
      { headers }
    );
    
    const subscriptions = await subsResponse.json() as Array<{
      id: string;
      feed_url: string;
      podcast_title: string;
    }>;
    
    if (subscriptions.length === 0) {
      return json({ error: "No subscriptions found", user_id: userId });
    }
    
    const feedUrls = subscriptions.map(s => s.feed_url);
    const feedUrlFilter = feedUrls.map(u => `"${u}"`).join(",");
    
    // Get ALL episodes from those feeds (no date filter)
    const episodesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?feed_url=in.(${feedUrlFilter})&select=id,title,feed_url,published_at,created_at&order=created_at.desc&limit=20`,
      { headers }
    );
    
    const episodes = await episodesResponse.json() as Array<{
      id: string;
      title: string;
      feed_url: string;
      published_at: string;
      created_at: string;
    }>;
    
    // Get already covered episodes
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const digestsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/digests?user_id=eq.${userId}&digest_date=gte.${weekAgo}&select=id,digest_date,episodes_included`,
      { headers }
    );
    
    const recentDigests = await digestsResponse.json() as Array<{
      id: string;
      digest_date: string;
      episodes_included: string[];
    }>;
    
    const coveredEpisodeIds = new Set<string>();
    for (const d of recentDigests) {
      for (const epId of (d.episodes_included || [])) {
        coveredEpisodeIds.add(epId);
      }
    }
    
    return json({
      user_id: userId,
      subscriptions: subscriptions.map(s => ({
        podcast: s.podcast_title,
        feed_url: s.feed_url,
      })),
      episodes_in_db: episodes.map(e => ({
        id: e.id,
        title: e.title.slice(0, 60) + (e.title.length > 60 ? '...' : ''),
        feed_url: e.feed_url,
        published_at: e.published_at,
        created_at: e.created_at,
        already_covered: coveredEpisodeIds.has(e.id),
      })),
      recent_digests: recentDigests.map(d => ({
        id: d.id,
        date: d.digest_date,
        episodes_count: (d.episodes_included || []).length,
      })),
      summary: {
        subscription_count: subscriptions.length,
        total_episodes: episodes.length,
        covered_episodes: coveredEpisodeIds.size,
        recent_digest_count: recentDigests.length,
      }
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return json({ error: errorMsg }, 500);
  }
}

// Daily cron trigger - now routes to dispatcher (async) or legacy (sync)
// The dispatcher is preferred as it avoids timeout issues
async function handleDailyCron(env: Env, ctx: ExecutionContext): Promise<Response> {
  // If queue is configured, use async dispatcher
  if (env.DIGEST_QUEUE) {
    console.log("[DailyCron] Using async queue dispatcher");
    return handleDispatcher(env);
  }
  
  // Legacy synchronous mode (fallback if queues not configured)
  console.log("[DailyCron] Using legacy synchronous mode (no queue configured)");
  return handleLegacyDailyCron(env, ctx);
}

// Legacy synchronous cron handler (kept for backwards compatibility)
async function handleLegacyDailyCron(env: Env, ctx: ExecutionContext): Promise<Response> {
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
            `https://api.podgest.app/api/generate-digest`,
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
      force?: boolean;  // Skip "already covered" check
    };
    
    const forceGenerate = body.force === true;
    
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    const hoursBack = body.hours_back || 24;
    const userId = body.user_id || "00000000-0000-0000-0000-000000000000";
    
    // Validate user_id is a proper UUID
    if (!isValidUUID(userId)) {
      return json({ error: "Invalid user_id format" }, 400);
    }
    
    // Fetch user's digest length preference (default 5 minutes)
    let maxLengthMinutes = 5;
    try {
      const profileResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=digest_length_minutes`,
        { headers }
      );
      if (profileResponse.ok) {
        const profiles = await profileResponse.json() as Array<{ digest_length_minutes?: number }>;
        if (profiles.length > 0 && profiles[0].digest_length_minutes) {
          maxLengthMinutes = profiles[0].digest_length_minutes;
        }
      }
    } catch (e) {
      console.log(`[Digest] Could not fetch digest length preference, using default ${maxLengthMinutes} minutes`);
    }
    
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
    
    // 2. Get THIS USER's subscriptions first - only include episodes from podcasts they subscribe to
    const userSubscriptionsResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&is_active=eq.true&select=feed_url,podcast_title,publication_frequency_days`,
      { headers }
    );
    
    if (!userSubscriptionsResponse.ok) {
      return json({ error: "Failed to fetch user subscriptions" }, 500);
    }
    
    const userSubscriptions = await userSubscriptionsResponse.json() as Array<{ 
      feed_url: string; 
      podcast_title: string;
      publication_frequency_days: number | null;
    }>;
    
    if (userSubscriptions.length === 0) {
      return json({ error: "No active subscriptions found for user" }, 404);
    }
    
    // Build maps of user's subscribed feed URLs, podcast names, and frequencies
    const userFeedUrls = new Set(userSubscriptions.map(s => s.feed_url));
    const podcastNames = new Map<string, string>();
    const podcastFrequencies = new Map<string, number>();
    for (const sub of userSubscriptions) {
      podcastNames.set(sub.feed_url, sub.podcast_title);
      // Default to 1 (daily) if unknown, so we don't over-prioritize unknown podcasts
      podcastFrequencies.set(sub.feed_url, sub.publication_frequency_days ?? 1);
    }
    
    console.log(`[Digest] User has ${userSubscriptions.length} active subscriptions`);
    
    // 3. Fetch recent episodes ONLY from user's subscribed feeds
    const cutoffDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    
    // Build feed URL filter for the query
    const feedUrlFilter = [...userFeedUrls].map(u => `"${u}"`).join(",");
    
    const episodesResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/episodes?created_at=gte.${cutoffDate}&feed_url=in.(${feedUrlFilter})&select=id,title,description,published_at,feed_url`,
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
    
    console.log(`[Digest] Found ${episodes.length} episodes from user's subscriptions`);
    
    // Filter out episodes already covered in recent digests (unless force=true)
    const originalCount = episodes.length;
    if (!forceGenerate) {
      episodes = episodes.filter(ep => !alreadyCoveredEpisodes.has(ep.id));
    } else {
      console.log(`[Digest] Force mode: skipping already-covered filter`);
    }
    
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
    
    // Sort episodes by priority weight (less frequent podcasts get higher priority)
    // Weight = publication_frequency_days (weekly=7 gets higher weight than daily=1)
    episodes.sort((a, b) => {
      const freqA = podcastFrequencies.get(a.feed_url) ?? 1;
      const freqB = podcastFrequencies.get(b.feed_url) ?? 1;
      // Higher frequency days = less frequent = higher priority
      return freqB - freqA;
    });
    
    // Log episode order for debugging
    console.log(`[Digest] Episode order by priority:`);
    for (const ep of episodes.slice(0, 5)) {
      const freq = podcastFrequencies.get(ep.feed_url) ?? 1;
      const name = podcastNames.get(ep.feed_url) || "Unknown";
      console.log(`  - ${name}: ${ep.title.substring(0, 40)}... (freq: ${freq} days)`);
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
      return json({ error: "Failed to save digest record" }, 500);
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
            webhook_url: "https://api.podgest.app/api/webhooks/tts",
            admin_key: env.ADMIN_API_KEY,
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
    // Return user-friendly errors for known issues, generic message for unknown
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("API key") || message.includes("quota") || message.includes("rate limit")) {
      return json({ error: message }, 500);
    }
    return json({ error: "Digest generation failed. Please try again later." }, 500);
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

async function handleRSSFeed(userId: string, env: Env, baseUrl?: string): Promise<Response> {
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
    
    // Build RSS XML - use the actual request URL for self-references
    const feedBaseUrl = baseUrl || "https://api.podgest.app";
    const feedUrl = `${feedBaseUrl}/feed/${userId}.xml`;
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
      
      let hasWelcomeEpisode = false;
      
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
          hasWelcomeEpisode = true;
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
      
      // If no welcome episode exists, add a placeholder so the feed isn't empty
      if (!hasWelcomeEpisode) {
        const placeholderDate = new Date().toUTCString();
        // Use a static placeholder GUID based on user ID so it's consistent
        const placeholderGuid = `placeholder-${userId}`;
        
        items.push(`
    <item>
      <title><![CDATA[Welcome to Podgest, ${userName}!]]></title>
      <description><![CDATA[Your personalized podcast digest is being set up. Add some podcasts and configure your API keys at dash.podgest.app, then your first digest will arrive tomorrow morning at 6 AM!]]></description>
      <pubDate>${placeholderDate}</pubDate>
      <guid isPermaLink="false">${placeholderGuid}</guid>
      <itunes:duration>0:00</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
      <itunes:episodeType>trailer</itunes:episodeType>
      <itunes:summary>Your first daily digest arrives tomorrow morning! Set up your podcasts at dash.podgest.app</itunes:summary>
    </item>`);
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
    
    // Always include user's name in title for uniqueness on Spotify/podcast platforms
    const feedTitle = `Podgest - ${userName}'s Daily Digest`;
    
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

// Handle OG preview for social media crawlers hitting RSS feed URLs
async function handleFeedOGPreview(userId: string, env: Env, baseUrl: string): Promise<Response> {
  try {
    const headers = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    
    // Get user profile for personalization
    const profileResponse = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id,email,display_name`,
      { headers }
    );
    
    let userName = "Your";
    if (profileResponse.ok) {
      const profiles = await profileResponse.json() as Array<{ id: string; email?: string; display_name?: string }>;
      if (profiles.length > 0) {
        if (profiles[0].display_name) {
          userName = profiles[0].display_name.split(' ')[0] + "'s";
        } else if (profiles[0].email) {
          const emailPart = profiles[0].email.split('@')[0];
          const firstName = emailPart.split(/[._0-9]/)[0];
          if (firstName && firstName.length > 1) {
            userName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase() + "'s";
          }
        }
      }
    }
    
    const feedUrl = `${baseUrl}/feed/${encodeURIComponent(userId)}.xml`;
    const ogImage = "https://xpviiukiavtpsnafpdmy.supabase.co/storage/v1/object/public/digests/og-image.png";
    // Escape user-controlled data for safe HTML embedding
    const safeUserName = escapeHtml(userName);
    const title = `Podgest - ${safeUserName} AI Podcast Digest`;
    const description = "Personalized daily podcast digest, powered by AI. Never miss the highlights from your favorite shows.";
    
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <meta name="description" content="${description}">
  
  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Podgest">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${feedUrl}">
  
  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${ogImage}">
  
  <!-- Redirect non-crawlers to the actual feed -->
  <meta http-equiv="refresh" content="0;url=${feedUrl}">
</head>
<body>
  <p>Redirecting to podcast feed...</p>
  <p><a href="${feedUrl}">${title}</a></p>
</body>
</html>`;
    
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    console.error("[FeedOG] Error:", error);
    // Fall back to RSS feed on error
    return handleRSSFeed(userId, env, baseUrl);
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
 * 
 * Basic format validation is performed before making external API calls
 * to avoid being used as an oracle for brute-forcing API keys.
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
    
    // Basic format validation to reject obviously invalid keys
    // before making external API calls (prevents abuse as a key-testing oracle)
    const key = body.key.trim();
    if (key.length < 10 || key.length > 256) {
      return json({ valid: false, error: "Invalid key format", errorCode: 'invalid_key' }, 400);
    }
    
    // Validate key format matches expected provider patterns
    if (body.key_type === 'openai' && !key.startsWith('sk-')) {
      return json({ valid: false, error: "OpenAI keys should start with 'sk-'", errorCode: 'invalid_key' }, 400);
    }
    if (body.key_type === 'anthropic' && !key.startsWith('sk-ant-')) {
      return json({ valid: false, error: "Anthropic keys should start with 'sk-ant-'", errorCode: 'invalid_key' }, 400);
    }
    
    let result: { valid: boolean; error?: string; errorCode?: string };
    
    switch (body.key_type) {
      case 'openai':
        result = await validateOpenAIKeyDetailed(key);
        break;
        
      case 'anthropic':
        result = await validateAnthropicKeyDetailed(key);
        break;
        
      case 'elevenlabs':
        result = await validateElevenLabsKeyDetailed(key);
        break;
        
      default:
        return json({ valid: false, error: "Invalid key_type" }, 400);
    }
    
    return json(result);
    
  } catch (error) {
    console.error("[ValidateKey] Error:", error);
    return json({ 
      valid: false, 
      error: "Validation failed",
      errorCode: 'unknown'
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
    // Verify JWT token via Supabase Auth
    const auth = await verifySupabaseJWT(request, env);
    if (!auth) {
      return json({ error: "Unauthorized: invalid or expired token" }, 401);
    }
    const userId = auth.userId;
    
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
    
    // Validate the key before saving
    let validationResult: { valid: boolean; error?: string; errorCode?: string };
    switch (body.key_type) {
      case 'openai':
        validationResult = await validateOpenAIKeyDetailed(body.key);
        break;
      case 'anthropic':
        validationResult = await validateAnthropicKeyDetailed(body.key);
        break;
      case 'elevenlabs':
        validationResult = await validateElevenLabsKeyDetailed(body.key);
        break;
      default:
        return json({ error: `Invalid key_type: ${body.key_type}` }, 400);
    }
    
    if (!validationResult.valid) {
      return json({ 
        error: validationResult.error || "Invalid API key",
        errorCode: validationResult.errorCode
      }, 400);
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
      [validColumn]: true,  // Key was validated above
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
        console.error("[SaveUserKey] Update failed:", err);
        return json({ error: "Failed to save key" }, 500);
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
        console.error("[SaveUserKey] Insert failed:", err);
        return json({ error: "Failed to save key" }, 500);
      }
      
      return json({ success: true, action: "created" });
    }
    
  } catch (error) {
    console.error("[SaveUserKey] Error:", error);
    return json({ error: "Failed to save key" }, 500);
  }
}

// ============================================
// FEED PARSING & LISTENNOTES DETECTION
// ============================================

interface ParsedPodcast {
  title: string;
  feed_url: string;
  artwork_url?: string;
  publication_frequency_days: number | null;
}

async function handleParseFeed(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { feed_url: string };
    const { feed_url } = body;
    
    if (!feed_url) {
      return json({ error: "feed_url is required" }, 400);
    }
    
    console.log(`[ParseFeed] Parsing: ${feed_url}`);
    
    // Parse the RSS feed
    const feed = await parseRSSFeed(feed_url);
    
    // Calculate publication frequency for this feed
    const publicationFrequency = calculateFrequencyFromRSS(feed.episodes);
    
    // Check if this is a ListenNotes aggregator feed by looking for ListenNotes patterns in episodes
    const detectedPodcasts = new Map<string, ParsedPodcast>();
    let isAggregator = false;
    
    for (const episode of feed.episodes) {
      const description = episode.description || "";
      
      // Check for ListenNotes pattern in description
      const podcastUrlMatch = description.match(/<strong>Podcast<\/strong>:\s*<a\s+href="(https:\/\/www\.listennotes\.com\/podcasts\/[^"]+)"[^>]*>([^<]+)<\/a>/i);
      
      if (podcastUrlMatch) {
        isAggregator = true;
        const listenNotesUrl = podcastUrlMatch[1];
        const podcastName = podcastUrlMatch[2].trim();
        
        // Skip if we already have this podcast
        if (detectedPodcasts.has(listenNotesUrl)) continue;
        
        console.log(`[ParseFeed] Detected podcast: ${podcastName} (${listenNotesUrl})`);
        
        // Try to get the original RSS URL from the ListenNotes page
        let originalRssUrl: string | null = null;
        try {
          originalRssUrl = await fetchOriginalRssUrl(listenNotesUrl);
        } catch (e) {
          console.warn(`[ParseFeed] Could not fetch RSS URL for ${podcastName}`);
        }
        
        if (originalRssUrl) {
          // Parse the original feed to get its frequency
          let originalFrequency: number | null = null;
          let artworkUrl: string | undefined;
          try {
            const originalFeed = await parseRSSFeed(originalRssUrl);
            originalFrequency = calculateFrequencyFromRSS(originalFeed.episodes);
            artworkUrl = originalFeed.artwork_url;
          } catch (e) {
            console.warn(`[ParseFeed] Could not parse original feed for ${podcastName}`);
          }
          
          detectedPodcasts.set(listenNotesUrl, {
            title: podcastName,
            feed_url: originalRssUrl,
            artwork_url: artworkUrl,
            publication_frequency_days: originalFrequency,
          });
        } else {
          // If we can't get the RSS URL, store what we have
          detectedPodcasts.set(listenNotesUrl, {
            title: podcastName,
            feed_url: listenNotesUrl, // This won't work for RSS polling, but shows the podcast
            publication_frequency_days: null,
          });
        }
      }
    }
    
    const result = {
      feed_title: feed.title,
      feed_url: feed_url,
      artwork_url: feed.artwork_url,
      episode_count: feed.episodes.length,
      publication_frequency_days: publicationFrequency,
      is_aggregator: isAggregator,
      detected_podcasts: isAggregator ? Array.from(detectedPodcasts.values()) : [],
    };
    
    console.log(`[ParseFeed] Result: ${result.feed_title}, ${result.episode_count} episodes, aggregator: ${isAggregator}, detected: ${result.detected_podcasts.length}`);
    
    return json(result);
    
  } catch (error) {
    console.error("[ParseFeed] Error:", error);
    return json({ 
      error: error instanceof Error ? error.message : "Failed to parse feed" 
    }, 500);
  }
}

// TTS now handled by Modal - see modal/transcribe.py
