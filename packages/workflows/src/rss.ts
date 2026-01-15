import { XMLParser } from "fast-xml-parser";

export interface RSSEpisode {
  guid: string;
  title: string;
  description: string;
  audio_url: string;
  duration_seconds: number | null;
  published_at: Date;
}

export interface RSSFeed {
  title: string;
  description: string;
  artwork_url: string | null;
  episodes: RSSEpisode[];
}

/**
 * Parse an RSS feed and extract episodes
 */
export async function parseRSSFeed(feedUrl: string): Promise<RSSFeed> {
  const response = await fetch(feedUrl, {
    headers: {
      "User-Agent": "Podgest/1.0 (podcast aggregator)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

  const parsed = parser.parse(xml);
  const channel = parsed.rss?.channel;

  if (!channel) {
    throw new Error("Invalid RSS feed: no channel found");
  }

  // Get feed metadata
  const feed: RSSFeed = {
    title: channel.title || "Unknown",
    description: channel.description || "",
    artwork_url: channel["itunes:image"]?.["@_href"] || channel.image?.url || null,
    episodes: [],
  };

  // Parse episodes
  const items = Array.isArray(channel.item) ? channel.item : [channel.item].filter(Boolean);

  for (const item of items) {
    const episode = parseEpisode(item);
    if (episode) {
      feed.episodes.push(episode);
    }
  }

  return feed;
}

function parseEpisode(item: any): RSSEpisode | null {
  // Get audio URL from enclosure
  const enclosure = item.enclosure;
  const audioUrl = enclosure?.["@_url"];

  if (!audioUrl) {
    // Skip episodes without audio
    return null;
  }

  // Parse GUID (use link as fallback)
  const guid = typeof item.guid === "string" 
    ? item.guid 
    : item.guid?.["#text"] || item.link || audioUrl;

  // Parse duration (could be HH:MM:SS or just seconds)
  const durationRaw = item["itunes:duration"];
  const durationSeconds = parseDuration(durationRaw);

  // Parse publish date
  const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

  return {
    guid,
    title: item.title || "Untitled Episode",
    description: item.description || item["itunes:summary"] || "",
    audio_url: audioUrl,
    duration_seconds: durationSeconds,
    published_at: pubDate,
  };
}

function parseDuration(duration: string | number | undefined): number | null {
  if (!duration) return null;

  if (typeof duration === "number") {
    return duration;
  }

  // Handle HH:MM:SS or MM:SS format
  const parts = duration.split(":").map(Number);
  
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1 && !isNaN(parts[0])) {
    return parts[0];
  }

  return null;
}
