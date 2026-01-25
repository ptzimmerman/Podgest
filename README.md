# Podgest

> **Daily podcast digest + AI-powered Q&A for podcast content**

Transform hours of daily podcasts into a 5-minute professional news recap, and query all your podcast knowledge via Claude or ChatGPT (desktop & mobile).

---

## Table of Contents

- [Overview](#overview)
- [Design Principles](#design-principles)
- [Architecture](#architecture)
- [Phase 1: Daily Podcast Digest](#phase-1-daily-podcast-digest)
- [Phase 2: Interactive Q&A (MCP Server)](#phase-2-interactive-qa-mcp-server)
- [Technology Decisions](#technology-decisions)
- [Database Schema](#database-schema)
- [Pipeline Timing](#pipeline-timing)
- [Cost Estimates](#cost-estimates)
- [Project Structure](#project-structure)
- [Implementation Roadmap](#implementation-roadmap)
- [Open Questions](#open-questions)

---

## Overview

### The Problem

You subscribe to many podcasts but don't have time to listen to them all. Hours of valuable content goes unconsumed daily.

### The Solution

**Podgest** ingests your podcast subscriptions, transcribes them, clusters by topic, summarizes into a professional 30-minute daily digest, and exposes an MCP server for natural language Q&A.

### Key Features

| Feature | Description |
|---------|-------------|
| **RSS Aggregation** | Subscribe to any podcast via RSS (or ListenNotes playlists) |
| **Auto-Transcription** | GPU-accelerated transcription via Modal (faster-whisper) |
| **Topic Extraction** | Claude extracts topics, themes, key points per episode |
| **Daily Digest** | 5-min professional news recap via ElevenLabs (expandable later) |
| **Smart Citations** | Host cites original source podcasts naturally |
| **Spotify Distribution** | Listen in your existing podcast app |
| **MCP Q&A** | Ask questions about any podcast content via Claude or ChatGPT |
| **Multi-tenant** | Supports multiple users with isolated data |
| **Cross-Platform** | Works on desktop and mobile (Claude, ChatGPT, Cursor) |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SUPABASE CLOUD                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │   PostgreSQL    │  │     Storage     │  │         pg_cron             │  │
│  │  - profiles     │  │  - transcripts  │  │  ┌─────────────────────┐    │  │
│  │  - episodes     │  │  - audio files  │  │  │ daily-digest-6am    │    │  │
│  │  - digests      │  │  - cover art    │  │  │ (0 12 * * * UTC)    │────┼──┼───┐
│  │  - subscriptions│  │                 │  │  ├─────────────────────┤    │  │   │
│  │  - transcripts  │  │                 │  │  │ watchdog-hourly     │    │  │   │
│  └────────┬────────┘  └────────┬────────┘  │  │ (30 * * * * UTC)    │────┼──┼───┤
│           │                    │           │  └─────────────────────┘    │  │   │
│           │                    │           └─────────────────────────────┘  │   │
└───────────┼────────────────────┼────────────────────────────────────────────┘   │
            │                    │                                                 │
            │  Supabase REST API │                                                 │
            ▼                    ▼                                                 │
┌─────────────────────────────────────────────────────────────────────────────┐   │
│                        CLOUDFLARE WORKERS                                    │   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │   │
│  │                     podgest-api Worker                               │◄───┼───┘
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │    │
│  │  │ /api/poll   │  │/api/generate│  │/api/daily-  │  │/transcript/│  │    │
│  │  │             │  │  -digest    │  │    cron     │  │  latest    │  │    │
│  │  │ RSS polling │  │ Script gen  │  │ Full flow   │  │ For Reader │  │    │
│  │  └──────┬──────┘  └──────┬──────┘  └─────────────┘  └────────────┘  │    │
│  └─────────┼────────────────┼──────────────────────────────────────────┘    │
│            │                │                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     podgest-mcp Worker                               │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │    │
│  │  │search_pods  │  │get_episode  │  │compare_takes│  │listen_to_  │  │    │
│  │  │             │  │             │  │             │  │  episode   │  │    │
│  │  │ SuperMemory │  │ Full detail │  │ Topic views │  │ Deep links │  │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘  │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
            │                │
            │                │ Webhook callbacks
            ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MODAL                                           │
│  ┌─────────────────────────────┐  ┌─────────────────────────────────────┐   │
│  │     Transcriber (GPU)       │  │         TTS Generator               │   │
│  │  - Download audio           │  │  - ElevenLabs API calls             │   │
│  │  - ffmpeg preprocessing     │  │  - Audio chunking & concatenation   │   │
│  │  - faster-whisper (A10G)    │  │  - Upload to Supabase Storage       │   │
│  │  - Webhook on completion    │  │  - Webhook on completion            │   │
│  └─────────────────────────────┘  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SUPERMEMORY                                        │
│  - Semantic embeddings of all transcripts                                    │
│  - Filtered by user_id (containerTags)                                       │
│  - Metadata: podcast_title, episode_title, published_at                      │
│  - Enables cross-episode Q&A queries                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Daily Digest Flow

```
6:00 AM (User's Timezone)
         │
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   pg_cron       │────▶│  /api/daily-    │────▶│   Poll RSS      │
│ trigger_daily   │     │     cron        │     │   feeds         │
│    _digest()    │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
         ┌───────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  New episodes?  │────▶│ Modal: Transcribe│────▶│  Claude: Extract│
│                 │     │  (GPU)          │     │  topics         │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
         ┌───────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  SuperMemory    │────▶│  Claude: Generate│────▶│  Modal: TTS     │
│  embed content  │     │  digest script  │     │  (ElevenLabs)   │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
         ┌───────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  Upload to      │────▶│  Available in   │
│  Supabase       │     │  podcast apps   │
│  Storage        │     │  & ElevenReader │
└─────────────────┘     └─────────────────┘
```

### Watchdog Pattern (Reliability)

The system has TWO scheduling mechanisms for reliability:

1. **Primary: `daily-digest-6am`** - Runs at 12:00 UTC (6 AM Mexico City)
2. **Backup: `watchdog-hourly`** - Runs at :30 past every hour, checks if today's digest exists, triggers if missing

```sql
-- Watchdog function (simplified)
CREATE FUNCTION watchdog_check_digest() RETURNS jsonb AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM digests WHERE digest_date = CURRENT_DATE) THEN
    -- No digest today - trigger generation via HTTP
    PERFORM net.http_post('https://podgest-api.../api/daily-cron');
    RETURN '{"status": "triggered"}'::jsonb;
  END IF;
  RETURN '{"status": "ok"}'::jsonb;
END;
$$;
```

---

## Phase 1: Daily Podcast Digest

### 1.1 Podcast Aggregation

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Feed Storage** | Supabase Postgres | User podcast subscriptions |
| **RSS Polling** | Supabase pg_cron | Check feeds every 15 min via Cloudflare Worker |
| **Episode Registry** | Supabase Postgres | Track processed episodes, prevent duplicates |

**Managing Subscriptions:**
- **Phase 1:** Add/edit podcasts directly in the Supabase `subscriptions` table via dashboard
- **Later:** Web UI for subscription management

**Finding RSS URLs:**
- Most podcasts link to their RSS feed on their website
- Or use [getrssfeed.com](https://getrssfeed.com) to find from Apple Podcasts/Spotify links

**Note:** Direct RSS polling with `rss-parser` is simpler and cheaper than ListenNotes API. No external dependencies.

### 1.2 Transcription Pipeline

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Orchestration** | Supabase pg_cron + Webhooks | Cron triggers + webhook callbacks |
| **Compute** | Modal (GPU) | Serverless A10G for Whisper |
| **Model** | `faster-whisper` (base) | Balance of speed and accuracy |
| **Preprocessing** | ffmpeg | Mono, 16kHz, silence removal |
| **Fallback** | Deepgram | Managed transcription if Modal fails |

**Modal Configuration:**

```python
@app.cls(
    gpu="A10G",
    timeout=1800,                # 30 min for long podcasts
    container_idle_timeout=300,  # Keep warm 5 min between jobs
    memory=8192,                 # 8GB RAM
    retries=2,                   # Auto-retry on transient failures
)
class Transcriber:
    @modal.enter()
    def load_model(self):
        # Model loaded once per container, reused across requests
        self.model = WhisperModel("base", device="cuda", compute_type="float16")
    
    @modal.method()
    def transcribe(self, audio_url: str, webhook_url: str, job_id: str):
        # Download, preprocess, transcribe
        result = self._process(audio_url)
        
        # Callback instead of client polling
        requests.post(webhook_url, json={
            "job_id": job_id,
            "status": "completed", 
            "transcript": result
        })
```

**Preprocessing (ffmpeg on Modal, not local):**
```bash
# This runs inside the Modal container, not on your machine
ffmpeg -y -i input.mp3 -ac 1 -ar 16000 -vn \
  -af "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-40dB" \
  output.wav
```

### 1.3 Storage Layer (Tiered)

| Data Type | Storage | Why |
|-----------|---------|-----|
| **Metadata** | Supabase Postgres | Structured queries, RLS, small |
| **Raw transcripts** | Supabase Storage | Large blobs, cheap, signed URLs |
| **Semantic chunks** | SuperMemory (or pgvector) | Embeddings, search, RAG |
| **Generated audio** | Supabase Storage (public) | CDN delivery for podcast RSS |

> ⚠️ **Verify Early (Phase 2):** Confirm SuperMemory supports our filtering needs:
> - Filter by `user_id` (multi-tenancy)
> - Filter by `date_range`
> - Filter by `podcast_name`
> 
> **Fallback options if SuperMemory doesn't fit:**
> - **Supabase pgvector** — Already in our stack, no new service. Requires DIY chunking + embedding (use OpenAI `text-embedding-3-small`). Good enough for our scale.
> - **Pinecone** — Battle-tested, excellent metadata filtering, but adds another service.

**Flow:**

```typescript
// 1. Store raw transcript in Storage
const { data } = await supabase.storage
  .from('transcripts')
  .upload(`${episodeId}.json`, JSON.stringify(transcript));

// 2. Store metadata in Postgres (NOT the full text)
await supabase.from('transcriptions').insert({
  episode_id: episodeId,
  status: 'completed',
  transcript_storage_path: data.path,
  word_count: transcript.text.split(' ').length,
});

// 3. Index in SuperMemory for semantic search
const { id } = await supermemory.add({
  content: transcript.text,
  metadata: {
    episode_id: episodeId,
    podcast: "Acquired",
    title: "NVIDIA Part III",
    date: "2026-01-14",
  }
});

// 4. Store SuperMemory reference
await supabase.from('transcriptions')
  .update({ supermemory_doc_id: id })
  .eq('episode_id', episodeId);
```

### 1.4 Topic Clustering

Since we want auto-clustering by topic for a professional news recap:

**Stage 1: Per-Episode Topic Extraction**
```
For each transcript, extract:
- topic_name: "NVIDIA Earnings", "AI Regulation"
- category: [AI/ML, Business, Technology, Markets, etc.]
- key_points: 2-3 bullets
- notable_quotes: Quotable moments
```

**Stage 2: Cross-Episode Merging**
```
Merge related topics across podcasts:
- "NVIDIA Q4 Earnings" + "Chip Industry Outlook" → "Semiconductor Update"
- Preserve source attribution for each perspective
```

**Stage 3: Script Structure**
```typescript
interface DigestScript {
  intro: string;  // 30 sec
  segments: Array<{
    topic: string;
    duration_target: number;
    sources: Array<{ podcast, episode, perspective }>;
    script: string;
    transition: string;
  }>;
  rapidFire: Array<{  // Quick hits
    headline: string;
    oneLineSummary: string;
    source: string;
  }>;
  outro: string;  // 15 sec
}
```

### 1.5 Audio Generation

> ⚠️ **Critical Clarification:** ElevenReader (elevenreader.io) is a **consumer app** for personal listening. It does NOT expose APIs or RSS feeds. 
>
> For programmatic audio generation, use **ElevenLabs API** (the parent company).

| Component | Technology | Purpose |
|-----------|------------|---------|
| **TTS Engine** | ElevenLabs API | Multi-voice conversation audio |
| **Voice Profile** | Single authoritative voice | Professional news recap style |
| **Post-processing** | ffmpeg (Modal or Edge Function) | Normalize, add intro/outro music |

**Voice Configuration for Professional Recap:**

```typescript
const voiceConfig = {
  voice_id: "pNInz6obpgDQGcFmaJgB",  // "Adam" - deep, professional
  settings: {
    stability: 0.75,
    similarity_boost: 0.75,
    style: 0.0,  // Neutral, not dramatic
    use_speaker_boost: true
  }
};
```

**Script Style Guide:**
- Tone: NPR Morning Edition meets Bloomberg Surveillance
- Language: Clear, precise, avoids jargon
- Attribution: Always credit sources ("According to Ben Gilbert on Acquired...")
- Pacing: Natural pauses between topics

### 1.6 Podcast Distribution

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Audio Storage** | Supabase Storage | Host MP3 files |
| **RSS Generator** | Edge Function | Dynamic podcast RSS feed |
| **CDN** | Supabase CDN | Fast audio delivery |

**RSS Feed Endpoint:** `GET /api/podcast/{user_id}/feed.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="...">
  <channel>
    <title>Podgest Daily - {username}</title>
    <description>Your daily podcast digest</description>
    <itunes:image href="https://...cover.jpg"/>
    <item>
      <title>January 14, 2026</title>
      <enclosure url="https://...2026-01-14.mp3" type="audio/mpeg"/>
      <pubDate>Wed, 14 Jan 2026 06:00:00 GMT</pubDate>
      <itunes:duration>30:00</itunes:duration>
    </item>
  </channel>
</rss>
```

**Spotify Submission:**
1. Submit RSS URL via [Spotify for Podcasters](https://podcasters.spotify.com)
2. Set visibility to **"Not searchable"** (can change later)
3. After approval (~24-48 hrs), new episodes appear automatically
4. Only you know the URL — not discoverable in Spotify search

**RSS URL Format:** Use obscure user ID to prevent guessing:
```
https://podgest.yourdomain.com/feed/a8f3b2c9-7d4e-4f1a-9b2c-8e5f3a1d7c6b
```

---

## Phase 2: Interactive Q&A (MCP Server)

### 2.1 MCP Server Architecture

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Runtime** | Cloudflare Workers | Edge-deployed MCP server |
| **Protocol** | MCP over HTTP/SSE | Universal client support |
| **Memory Backend** | SuperMemory API | Semantic search across transcripts |
| **Auth** | OAuth 2.1 + Google | User isolation via Supabase |

### Supported Clients

| Client | Platform | Setup Method |
|--------|----------|--------------|
| **Claude Desktop** | macOS, Windows | `mcp-remote` in config file |
| **Claude Mobile** | iOS, Android | MCP settings in claude.ai account |
| **ChatGPT Desktop** | macOS, Windows | Add connector in Developer Mode |
| **ChatGPT Mobile** | iOS, Android | MCP settings in chatgpt.com account |
| **Cursor** | macOS, Windows, Linux | `.cursor/mcp.json` in project |

**Note:** Mobile apps require configuring MCP servers through the web browser in your account settings (claude.ai or chatgpt.com), then the servers sync to the mobile app.

### 2.2 MCP Tools

```typescript
// Tool 1: Search across all podcast transcripts
{
  name: "search_podcasts",
  description: "Semantic search across all podcast transcripts",
  parameters: {
    query: "string - natural language question",
    date_range: "optional - filter by date",
    podcasts: "optional - filter by podcast name"
  },
  returns: {
    results: [
      {
        podcast: "Acquired",
        episode: "NVIDIA Part III",
        chunk: "Jensen Huang's strategy was to...",  // ~500 words
        relevance_score: 0.92
      }
    ]
  }
}

// Tool 2: Get episode details (metadata + summary, not full transcript)
{
  name: "get_episode",
  description: "Get episode metadata, summary, and link to full transcript",
  parameters: {
    episode_id: "string"
  },
  returns: {
    title: "NVIDIA Part III",
    podcast: "Acquired",
    date: "2026-01-14",
    duration_minutes: 135,
    summary: "Ben and David cover...",
    topics: ["semiconductors", "AI", "data centers"],
    full_transcript_url: "https://..."  // Signed URL, fetch separately if needed
  }
}

// Tool 3: Compare perspectives across podcasts
{
  name: "compare_takes",
  description: "Find how different podcasts covered the same topic",
  parameters: {
    topic: "string",
    date_range: "optional"
  },
  returns: {
    topic: "AI regulation",
    perspectives: [
      { podcast: "All-In", stance: "Against regulation", quote: "..." },
      { podcast: "Hard Fork", stance: "Pro guardrails", quote: "..." }
    ]
  }
}

// Tool 4: Get links to listen to full episode
{
  name: "listen_to_episode",
  description: "Get iOS app deep links + web fallbacks to listen to episode",
  parameters: {
    episode_id: "string"
  },
  returns: {
    episode_id: "abc123",
    podcast_name: "Acquired",
    title: "NVIDIA Part III",
    links: {
      audio_url: "https://...",           // Direct MP3 playback
      spotify_app: "spotify:search:...",  // Opens Spotify app directly (iOS)
      apple_app: "podcasts://search?...", // Opens Apple Podcasts app (iOS)
      spotify_web: "https://open.spotify.com/search/...",  // Web fallback
      apple_web: "https://podcasts.apple.com/search?...",  // Web fallback
      listennotes_url: "https://..."      // ListenNotes page (optional)
    }
  }
}
```

### 2.3 Authentication Flow (Browser-Based OAuth)

MCP supports OAuth 2.0 — **no token copy/paste needed**:

```
┌─────────────────┐                              ┌─────────────────┐
│  Claude Desktop │                              │   MCP Server    │
└────────┬────────┘                              └────────┬────────┘
         │                                                │
         │  1. Connect to MCP server                      │
         │  ─────────────────────────────────────────────▶│
         │                                                │
         │  2. Server requires auth, returns OAuth URL    │
         │  ◀─────────────────────────────────────────────│
         │                                                │
         │  3. Claude opens browser → Google OAuth        │
         │  ────────────────────────────────────────────▶ │
         │                                                │
         │  4. User signs in with Google                  │
         │     Google redirects to MCP server callback    │
         │                                                │
         │  5. MCP server stores session (Supabase Auth)  │
         │     Returns success to Claude                  │
         │  ◀─────────────────────────────────────────────│
         │                                                │
         │  6. MCP connection is now authenticated        │
         │     All subsequent requests use session        │
         │  ◀────────────────────────────────────────────▶│
```

### 2.4 Handling Large Content (No Durable Objects Needed)

**Concern:** Full transcripts could cause timeouts.

**Solution:** MCP tools return **small, fast responses**. Large content stays in Storage:

| MCP Tool | Returns | Size | Latency |
|----------|---------|------|---------|
| `search_podcasts` | SuperMemory chunks (excerpts) | ~500 words each | <1s |
| `get_episode` | Metadata + summary + signed URL | Small | <1s |
| `compare_takes` | Summarized perspectives | Small | <2s |
| `listen_to_episode` | iOS deep links + web URLs | Small | <1s |

**Full transcripts are NOT returned through MCP.** Instead:

```typescript
// get_episode returns a signed URL for the full transcript
{
  title: "NVIDIA Part III",
  podcast: "Acquired",
  summary: "Ben and David cover NVIDIA's data center dominance...",
  relevant_chunks: [...],  // From SuperMemory
  full_transcript_url: "https://xyz.supabase.co/storage/v1/object/sign/..."
}
```

If Claude needs the full transcript, it can fetch from the signed URL directly. This keeps MCP responses fast and avoids Cloudflare Worker timeouts.

---

## Technology Decisions

### Cloud-First Architecture

> ⚠️ **Important:** This project uses **Supabase Cloud exclusively** — no local Docker, no self-hosted Supabase. All processing happens in cloud services, not on your local machine.

| Processing Step | Where It Runs |
|-----------------|---------------|
| Database + Auth + Storage | Supabase Cloud |
| Workflow orchestration | Supabase pg_cron + Webhooks |
| Transcription + ffmpeg | Modal (cloud GPU) |
| Embeddings + search | SuperMemory (cloud) |
| TTS generation | ElevenLabs API |
| MCP server | Cloudflare Workers |
| Web app hosting | Vercel or Cloudflare Pages |

**Your local machine is only for:**
- Writing code
- Running the SvelteKit dev server for UI development
- Deploying to cloud services

### Why These Choices?

| Decision | Rationale |
|----------|-----------|
| **Supabase Cloud** | Managed Postgres, Auth, Storage, Edge Functions — no Docker needed |
| **Supabase pg_cron** | Built-in cron scheduling, watchdog pattern for reliability |
| **Modal** | Serverless GPU; ffmpeg + Whisper run there, not locally |
| **Deepgram as fallback** | Managed transcription if Modal has issues |
| **SuperMemory (or pgvector)** | Managed embeddings + search; verify filtering support early |
| **ElevenLabs API** | Best-in-class TTS |
| **Cloudflare Workers** | Edge-deployed MCP server |
| **Vercel/Cloudflare Pages** | Hosts the SvelteKit app |

### Why NOT These?

| Avoided | Reason |
|---------|--------|
| **Local Supabase (Docker)** | Differences from cloud; we want prod parity from day 1 |
| **Local preprocessing** | Nothing runs on your machine; all cloud |
| **Monolithic Edge Functions** | Timeout limits, hard to debug |
| **Polling for job completion** | Use webhooks instead |
| **Full transcripts in Postgres** | Use object storage |
| **DIY job queue** | Use pg_cron + webhooks |

---

## Design Principles

### Pitfalls to Avoid

Based on experience with similar podcast ingestion systems, here are anti-patterns we're explicitly avoiding:

| Anti-Pattern | Problem | Our Approach |
|--------------|---------|--------------|
| **Monolithic functions** | Timeout limits, one failure breaks chain, hard to debug | Small, focused webhook handlers with isolated failures |
| **Polling for async jobs** | Wastes execution time, risks timeout, orphans jobs | Webhook callbacks from Modal |
| **DIY job queue in DB** | No retries, no dead-letter, race conditions | pg_cron + watchdog pattern for reliability |
| **Full documents in Postgres** | Bloats DB, slows queries | Tiered storage (Postgres → S3 → SuperMemory) |
| **Tight coupling** | One failure cascades, no recovery | Event-driven architecture |
| **GPU workarounds** | CPU fallback is 5-10x slower | Proper GPU config + managed fallback (Deepgram) |

---

## Architecture

### Webhook-Based Pipeline

The system uses a simple, reliable webhook-based architecture with Supabase pg_cron for scheduling:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                    PODGEST                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                      SUPABASE pg_cron (Scheduler)                           ││
│  │  ┌────────────────────┐  ┌────────────────────┐                             ││
│  │  │ daily-digest-6am   │  │ watchdog-hourly    │                             ││
│  │  │ (0 12 * * * UTC)   │  │ (30 * * * * UTC)   │                             ││
│  │  └─────────┬──────────┘  └─────────┬──────────┘                             ││
│  └────────────┼───────────────────────┼────────────────────────────────────────┘│
│               │                       │                                          │
│               └───────────┬───────────┘                                          │
│                           │ HTTP POST                                            │
│                           ▼                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                    CLOUDFLARE WORKER (podgest-api)                          ││
│  │                                                                             ││
│  │   /api/daily-cron ─────┬─────▶ Poll RSS feeds                               ││
│  │                        │       │                                             ││
│  │                        │       ▼                                             ││
│  │                        │   New episodes? ──▶ Trigger Modal transcription    ││
│  │                        │                           │                         ││
│  │                        │                           │ webhook                 ││
│  │                        │                           ▼                         ││
│  │   /api/webhooks/modal ◀────────────────── Transcription complete            ││
│  │         │                                                                    ││
│  │         ▼                                                                    ││
│  │   Extract topics (Claude) ──▶ Embed in SuperMemory                          ││
│  │                        │                                                     ││
│  │                        ▼                                                     ││
│  │                   Check user digest_time                                     ││
│  │                        │                                                     ││
│  │                        ▼                                                     ││
│  │   /api/generate-digest ──▶ Generate script (Claude)                         ││
│  │                              │                                               ││
│  │                              │ HTTP POST                                     ││
│  │                              ▼                                               ││
│  │                         Modal TTS ──▶ ElevenLabs ──▶ Upload audio           ││
│  │                              │                                               ││
│  │                              │ webhook                                       ││
│  │                              ▼                                               ││
│  │   /api/webhooks/tts ◀─── TTS complete, update digest record                 ││
│  │                                                                             ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                              STORAGE LAYER                                  ││
│  ├──────────────────┬───────────────────────┬──────────────────────────────────┤│
│  │ Supabase Postgres│  Supabase Storage     │  SuperMemory                     ││
│  │ - profiles       │  - transcripts/       │  - Semantic chunks               ││
│  │ - episodes       │  - digests/*.mp3      │  - Embeddings                    ││
│  │ - digests        │  - cover.png          │  - Search index                  ││
│  │ - subscriptions  │                       │  - Filtered by user_id           ││
│  │ - transcriptions │                       │                                  ││
│  └──────────────────┴───────────────────────┴──────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

**Simple & Reliable:**
- No external event bus (removed Inngest dependency)
- Supabase pg_cron is built into our existing database
- Webhooks provide natural async handoffs between services
- Watchdog cron provides automatic retry if primary fails

**Webhook Flow:**
```
pg_cron ──HTTP──▶ Cloudflare Worker ──HTTP──▶ Modal
                        ▲                        │
                        │                        │
                        └────── webhook ─────────┘
```

**Benefits:**
- Each service is stateless and independently scalable
- Failures are isolated (Modal failure doesn't affect RSS polling)
- Easy to debug (every step has HTTP request/response logs)
- Dead-letter handling for permanently failed jobs
- Observability dashboard (see all running/failed jobs)
- Scheduled jobs with timezone support
- No infrastructure to manage

### Why Tiered Storage?

| Data Type | Storage | Reason |
|-----------|---------|--------|
| User profiles, subscriptions | Postgres | Structured, needs RLS, small |
| Episode metadata | Postgres | Query by date, podcast, etc. |
| Full transcripts | Supabase Storage (S3) | Large blobs, cheap storage |
| Semantic chunks | SuperMemory | Search, embeddings, RAG |
| Generated audio | Supabase Storage (public) | CDN delivery for RSS |

### Why Modal with Webhooks?

Instead of polling Modal for job completion (wasteful, timeout-prone), Modal calls us back:

```python
@app.function(gpu="A10G", timeout=900)
def transcribe_audio(audio_url: str, webhook_url: str, job_id: str):
    # Download and transcribe
    result = transcribe(audio_url)
    
    # Call webhook when done
    requests.post(webhook_url, json={
        "job_id": job_id,
        "status": "completed",
        "transcript": result
    })
```

The webhook handler processes the transcription and triggers downstream steps:

```typescript
// /api/webhooks/modal (Cloudflare Worker)
export async function handleModalWebhook(request, env) {
  const { job_id, transcript, status } = await request.json();
  
  // Update transcription record in Supabase
  await updateTranscription(env, job_id, transcript, status);
  
  // Extract topics with Claude
  await extractTopics(env, job_id);
  
  // Embed in SuperMemory
  await embedInSuperMemory(env, job_id);
  
  return new Response(JSON.stringify({ success: true }));
}
```

---

## Database Schema

> **Note:** Job orchestration is handled by **Supabase pg_cron** with a watchdog pattern.
> The primary cron runs at the scheduled time; the watchdog runs hourly to catch any missed runs.

```sql
-- ============================================
-- USERS & AUTH
-- ============================================

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT NOT NULL,
  display_name TEXT,
  timezone TEXT DEFAULT 'America/Los_Angeles',
  digest_time TIME DEFAULT '06:00:00',  -- When user wants digest ready
  digest_length_minutes INTEGER DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PODCAST SUBSCRIPTIONS
-- ============================================

CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  podcast_title TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  artwork_url TEXT,
  priority INTEGER DEFAULT 5,  -- 1-10, higher = more important for digest
  is_active BOOLEAN DEFAULT true,
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, feed_url)
);

-- ============================================
-- EPISODES (shared across users who subscribe to same podcast)
-- ============================================

CREATE TABLE public.episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_url TEXT NOT NULL,
  guid TEXT NOT NULL,  -- Unique episode ID from RSS
  title TEXT NOT NULL,
  description TEXT,
  audio_url TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(feed_url, guid)
);

-- ============================================
-- TRANSCRIPTIONS
-- Note: Full transcript stored in Supabase Storage, not here
-- ============================================

CREATE TABLE public.transcriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE UNIQUE,
  status TEXT DEFAULT 'pending',  -- pending, processing, completed, failed
  
  -- Storage references (NOT the actual content)
  transcript_storage_path TEXT,  -- e.g., 'transcripts/{id}.json' in Supabase Storage
  supermemory_doc_id TEXT,       -- Reference to SuperMemory document
  
  -- Metadata (queryable)
  word_count INTEGER,
  language TEXT DEFAULT 'en',
  processing_time_ms INTEGER,
  
  -- Error tracking
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ============================================
-- TOPIC EXTRACTIONS (per transcription)
-- ============================================

CREATE TABLE public.topic_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transcription_id UUID REFERENCES public.transcriptions(id) ON DELETE CASCADE UNIQUE,
  topics JSONB NOT NULL,  -- [{name, category, key_points, quotes, time_range}]
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- DAILY DIGESTS (per-user)
-- ============================================

CREATE TABLE public.digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending, generating, completed, failed
  
  -- Topic clustering result
  topic_clusters JSONB,  -- [{topic, sources: [{podcast, episode, perspective}]}]
  
  -- Generated content (stored in Supabase Storage)
  script_storage_path TEXT,     -- 'digests/{id}/script.txt'
  audio_storage_path TEXT,      -- 'digests/{id}/audio.mp3'
  audio_url TEXT,               -- Public CDN URL for RSS feed
  duration_seconds INTEGER,
  
  -- Source tracking
  episodes_included UUID[],
  total_source_minutes INTEGER,
  
  -- Processing metrics
  processing_time_ms INTEGER,
  error_message TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, digest_date)
);

-- ============================================
-- MCP TOKENS (for Claude Desktop auth)
-- ============================================

CREATE TABLE public.mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,  -- bcrypt hash, never store plaintext
  name TEXT,                 -- "Claude Desktop - MacBook Pro"
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- EVENT LOG (for debugging/audit, optional)
-- ============================================

CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,  -- 'episode.created', 'transcription.completed', etc.
  entity_type TEXT,          -- 'episode', 'transcription', 'digest'
  entity_id UUID,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying events by type/entity
CREATE INDEX idx_events_type ON public.events(event_type, created_at DESC);
CREATE INDEX idx_events_entity ON public.events(entity_type, entity_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

-- Users can only access their own data
CREATE POLICY "Users own their profile" ON public.profiles
  FOR ALL USING (auth.uid() = id);

CREATE POLICY "Users own their subscriptions" ON public.subscriptions
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their digests" ON public.digests
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their tokens" ON public.mcp_tokens
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can view their events" ON public.events
  FOR SELECT USING (auth.uid() = user_id);

-- Episodes and transcriptions are shared (accessed via service role in backend)
-- No RLS on episodes/transcriptions - backend uses service role key
```

### Storage Buckets (Supabase Storage)

```sql
-- Create storage buckets
INSERT INTO storage.buckets (id, name, public) VALUES 
  ('transcripts', 'transcripts', false),  -- Private, accessed via signed URLs
  ('digests', 'digests', true);           -- Public, served via CDN for RSS

-- RLS for storage (users can only access their own digest audio)
CREATE POLICY "Public digest access" ON storage.objects
  FOR SELECT USING (bucket_id = 'digests');

CREATE POLICY "Service role transcript access" ON storage.objects
  FOR ALL USING (bucket_id = 'transcripts' AND auth.role() = 'service_role');
```

---

## Pipeline Timing

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DAILY PIPELINE (User TZ: PST)                    │
├──────────┬──────────────────────────────────────────────────────────┤
│ Time     │ Stage                                                    │
├──────────┼──────────────────────────────────────────────────────────┤
│ Ongoing  │ RSS Polling (every 30 min) → Queue new episodes          │
│ Ongoing  │ Transcription (process queue, ~10 min per hour of audio) │
│          │                                                          │
│ 2:00 AM  │ ▶ Digest Generation Triggered                            │
│ 2:05 AM  │   Collect transcripts from past 24h                      │
│ 2:10 AM  │   Topic extraction per episode (~2 min)                  │
│ 2:20 AM  │   Cross-episode topic clustering (~5 min)                │
│ 2:35 AM  │   Script generation (~3 min)                             │
│ 2:45 AM  │   ElevenLabs TTS (~10 min for 30-min audio)              │
│ 3:00 AM  │   Audio post-processing (intro, normalize)               │
│ 3:15 AM  │   Upload to storage, update RSS feed                     │
│ 3:20 AM  │ ✅ Digest ready                                          │
│          │                                                          │
│ 6:00 AM  │ User wakes up, digest appears in Spotify                 │
└──────────┴──────────────────────────────────────────────────────────┘
```

---

## Cost Estimates

### Per-User Monthly Costs

| Service | Tier | Monthly Cost | Notes |
|---------|------|--------------|-------|
| Supabase | Pro (shared) | ~$5 | Amortized across users |
| Modal | Usage | ~$15-25 | ~90 hrs audio/mo @ CPU rates |
| SuperMemory | Pro | ~$6 | 3M tokens shared |
| ElevenLabs | Creator | ~$7 | ~30 min audio/day |
| Claude API | Usage | ~$10 | Summarization + scripts |
| **Total per user** | | **~$43-53/mo** | |

### Platform Fixed Costs

| Service | Tier | Monthly Cost |
|---------|------|--------------|
| Supabase | Pro | $25 |
| Cloudflare Workers | Free | $0 |
| Domain | Annual | ~$1 |
| **Platform total** | | **~$26/mo** |

---

## Project Structure

```
podgest/
├── apps/
│   ├── web/                          # API endpoints + minimal UI (SvelteKit)
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── +page.svelte              # Status dashboard (optional)
│   │   │   │   ├── login/+page.svelte        # OAuth flow
│   │   │   │   ├── tokens/+page.svelte       # MCP token generation
│   │   │   │   └── api/
│   │   │   │       ├── (removed inngest)      # Now using pg_cron
│   │   │   │       ├── feed/[userId]/+server.ts  # Podcast RSS feed
│   │   │   │       └── webhooks/
│   │   │   │           └── modal/+server.ts  # Modal completion callback
│   │   │   └── lib/
│   │   │       ├── supabase.ts
│   │   │       └── (removed)                  # Inngest removed
│   │   ├── package.json
│   │   └── svelte.config.js
│   │
│   └── mcp-server/                   # Cloudflare Worker
│       ├── src/
│       │   ├── index.ts              # MCP protocol handler
│       │   ├── auth.ts               # Token validation
│       │   ├── tools/
│       │   │   ├── search.ts
│       │   │   ├── episode.ts
│       │   │   └── compare.ts
│       │   └── supermemory.ts
│       ├── wrangler.toml
│       └── package.json
│
├── packages/
│   ├── core/                         # Shared types and constants
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   └── constants.ts
│   │   └── package.json
│   │
│   └── workflows/                    # (deprecated - moved to podgest-api worker)
│       ├── src/
│       │   ├── client.ts             # (removed)
│       │   ├── functions/            # Logic now in podgest-api worker
│       │   └── events.ts             # (removed)
│       └── package.json
│
├── modal/
│   ├── transcribe.py                 # Modal transcription endpoint (GPU)
│   ├── audio_utils.py                # ffmpeg preprocessing
│   └── requirements.txt
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_initial_schema.sql
│   │   └── 002_storage_buckets.sql
│   ├── functions/
│   │   └── serve-rss/index.ts        # Simple RSS feed generator (stateless)
│   └── config.toml
│
├── scripts/                          # Dev utilities only (not part of production)
│   ├── test-modal.ts                 # Test Modal endpoint is working
│   └── trigger-digest.ts             # Manually trigger a digest for testing
│
├── .env.example
├── package.json                      # pnpm workspaces
├── pnpm-workspace.yaml
├── turbo.json
└── README.md                         # This file
```

### Key Architectural Patterns

| Concern | Approach |
|---------|----------|
| **Job orchestration** | Supabase pg_cron with watchdog pattern |
| **Async compute** | Modal webhooks (not polling) |
| **Large content** | Supabase Storage for blobs, Postgres for metadata |
| **Search** | SuperMemory for semantic search + embeddings |
| **Retries** | Watchdog cron checks hourly, retriggers if missing |

---

## Implementation Roadmap

### Phase 1: Foundation & Infrastructure
- [x] Initialize monorepo (pnpm + turborepo)
- [x] Set up Supabase project with schema + storage buckets
- [x] Set up Supabase pg_cron for scheduling
- [ ] Implement Google OAuth flow (skipped for now — using magic links)
- [x] Deploy Modal transcription endpoint with proper GPU config
- [x] Add initial podcast subscriptions via Supabase dashboard

### Phase 2: Ingestion Pipeline
- [x] **Verify SuperMemory** supports user_id, date, podcast filtering ✅ (containerTags + metadata filters)
- [x] RSS polling via pg_cron (every 15 min)
- [x] Transcription trigger via Modal webhook
- [x] Modal webhook callback endpoint (`/api/webhooks/modal`)
- [x] `extract-topics` function (Claude Sonnet 4) — auto-triggers after transcription completes
- [x] `embed-content` function (stores in SuperMemory) — auto-triggers after topic extraction
- [x] Deploy API (Cloudflare Workers) for webhook endpoints
- [x] Configure pg_cron jobs in Supabase
- [x] Test full pipeline with 2-3 real podcasts

### Phase 3: Digest Generation ✅
- [x] `generate-digest` endpoint (POST `/api/generate-digest`)
- [x] Script generation with news broadcaster style (Claude Sonnet 4)
- [x] Host persona: Alex Chen, neutral news reader
- [x] Accurate podcast citations (extracts original podcast names from ListenNotes)
- [x] Peter Zeihan content permanently excluded
- [x] ElevenLabs TTS integration (single voice: Eric) via Modal
- [x] Async TTS generation (Worker triggers Modal, returns immediately)
- [x] TTS webhook callback (`/api/webhooks/tts`)
- [x] Store generated audio in Supabase Storage (`digests` bucket)
- [x] Save digest records to database for RSS feed
- [x] Scheduled generation via pg_cron (per-user timezone)
- [x] Free Edge TTS endpoint for testing (`test-audio` bucket)
- [ ] Conversational two-host format (future - requires ElevenLabs enterprise)

### Phase 4: Distribution + MCP ✅
- [x] RSS feed endpoint (`/feed/{userId}`) - Spotify/iTunes compatible
- [x] Upload podcast cover art to Supabase Storage (staging)
- [ ] Submit personal feed to Spotify for Podcasters (waiting for production domain)
- [x] MCP server implementation (Cloudflare Worker) - fully remote, no local proxy
- [x] SuperMemory query integration in MCP tools (`search_podcasts`, `compare_takes`)
- [x] Direct remote MCP connection (no local proxy needed!)
- [x] Cursor project MCP config (`.cursor/mcp.json`)
- [x] Test with Claude Desktop + Cursor
- [x] OAuth authentication flow (see Phase 4.1 below)
- [x] One-time auth CLI for API key generation
- [x] ChatGPT support (desktop + mobile via OAuth 2.1 discovery)

### Phase 4.1: OAuth Authentication (Multi-User Support) ✅

This sub-phase enables proper authentication so multiple users can use Podgest with their own isolated data.

#### Architecture Overview (Fully Remote - No Local Proxy)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ONE-TIME AUTH SETUP                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. User runs: node apps/mcp-server/auth-cli/index.js                       │
│                                                                              │
│  2. Browser opens → https://podgest-mcp.../auth                             │
│                           │                                                  │
│                           ▼                                                  │
│  3. Google OAuth → Supabase Auth → Redirect to MCP server /auth/callback    │
│                                          │                                   │
│                                          ▼                                   │
│  4. MCP server generates API key, redirects to localhost:9876/save          │
│                                          │                                   │
│                                          ▼                                   │
│  5. Auth CLI saves key to ~/.podgest/api_key AND updates .cursor/mcp.json   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         RUNTIME (Direct Connection)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐                         ┌─────────────────────────────┐│
│  │  Cursor / Claude │ ─── HTTPS + API Key ──▶│  Cloudflare Worker          ││
│  │  (no local proxy)│                        │  podgest-mcp.pztest...      ││
│  └─────────────────┘                         └──────────────┬──────────────┘│
│                                                             │               │
│         Authorization: Bearer pk_xxxxx                      │               │
│                                                             ▼               │
│                                              ┌─────────────────────────────┐│
│                                              │  Supabase + SuperMemory     ││
│                                              │  (user_id from API key)     ││
│                                              └─────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Setup Steps

**Part A: Google Cloud Console** ✅
- [x] A1. Create Google Cloud project (or use existing)
- [x] A2. Configure OAuth consent screen
  - App name: "Podgest"
  - User type: External (for multi-user) or Internal (Google Workspace only)
  - Scopes: `email`, `profile`, `openid`
  - Test users: Add your email (required while in "Testing" status)
- [x] A3. Create OAuth 2.0 Client ID
  - Application type: **Web application**
  - Name: "Podgest Supabase Auth"
  - Authorized redirect URIs: `https://xpviiukiavtpsnafpdmy.supabase.co/auth/v1/callback`
- [x] A4. Copy **Client ID** and **Client Secret**

**Part B: Supabase Auth Configuration** ✅
- [x] B1. Go to Supabase Dashboard → Authentication → Providers → Google
- [x] B2. Enable Google provider
- [x] B3. Paste Google Client ID and Client Secret
- [x] B4. Add to Redirect URLs (Authentication → URL Configuration):
  - `http://localhost:9876/callback` (for local proxy OAuth callback)
- [x] B5. Verify `profiles` table auto-creation trigger exists (or create on first login)

**Part C: Auth CLI + Direct Remote Connection** ✅
- [x] C1. Create one-time auth CLI (`apps/mcp-server/auth-cli/`)
  - Opens browser to `https://podgest-mcp.../auth`
  - Receives API key via localhost:9876 redirect
  - Saves API key to `~/.podgest/api_key`
  - Updates `.cursor/mcp.json` automatically
- [x] C2. Direct remote connection (no local proxy running)
- [x] C3. API keys stored in `mcp_tokens` table (long-lived, no refresh needed)

**Part D: Remote MCP Server Updates** ✅
- [x] D1. Add auth middleware to validate JWT:
  ```typescript
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return new Response("Unauthorized", { status: 401 });
  const userId = user.id;
  ```
- [x] D2. Pass `userId` to all tool handlers (instead of hardcoded constant)
- [x] D3. Update SuperMemory queries to use `containerTags: [userId]`
- [x] D4. Update Supabase queries to use `user_id=eq.${userId}`
- [x] D5. Handle missing/invalid token gracefully (return helpful error)

**Part E: New User Onboarding Flow** ✅
- [x] E1. User adds `podgest` to Claude Desktop config (or Cursor)
- [x] E2. First MCP request triggers OAuth flow automatically
- [x] E3. Browser opens → Google sign-in → redirect to localhost callback
- [x] E4. Token saved locally, MCP ready to use
- [x] E5. User's profile created in Supabase if first login
- [x] E6. Subsequent sessions reuse saved token (until expiry)

**Part F: Profile Auto-Creation** ✅
- [x] F1. Create Supabase trigger to auto-create profile on first auth:
  ```sql
  CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS TRIGGER AS $$
  BEGIN
    INSERT INTO public.profiles (id, email, display_name, timezone, digest_time)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
      'America/Chicago',  -- Default timezone
      '06:00:00'          -- Default digest time
    );
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql SECURITY DEFINER;

  CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  ```

#### Security Considerations

| Concern | Solution |
|---------|----------|
| Token storage | Stored in `~/.podgest/token` with 600 permissions (user-only read/write) |
| Token in URL | Supabase uses fragment (`#access_token=...`) not query param — never sent to server logs |
| Token expiry | Supabase JWTs expire in 1 hour; refresh token flow handles re-auth |
| User isolation | SuperMemory `containerTags` + Supabase RLS enforce data boundaries |
| New user data | New users start with empty subscriptions; admin can seed initial podcasts |

#### Multi-User Data Isolation

| Data Type | Isolation Method |
|-----------|------------------|
| Subscriptions | `user_id` foreign key + RLS |
| Episodes | Shared (no user_id) - all users see same episodes for same podcasts |
| Transcriptions | Shared (linked to episodes) |
| Topic Extractions | Shared (linked to transcriptions) |
| SuperMemory embeddings | `containerTags: [user_id]` filter |
| Digests | `user_id` foreign key + RLS |
| MCP Tokens | `user_id` foreign key + RLS |

#### Testing Checklist
- [x] Fresh user can authenticate via Google
- [x] Token is saved and reused across Claude Desktop restarts
- [x] Expired token triggers re-auth automatically
- [ ] User A cannot see User B's subscriptions or digests (needs second user to test)
- [x] SuperMemory searches are scoped to authenticated user
- [x] New user gets profile auto-created

### Phase 5: Production Deployment & Polish

#### 5.1 Custom Domain Setup
- [ ] Register domain (e.g., `podgest.io` or use subdomain of existing domain)
- [ ] Configure Cloudflare DNS
- [ ] Update Cloudflare Workers with custom domains:
  - `api.podgest.yourdomain.com` → podgest-api worker (RSS, webhooks)
  - `mcp.podgest.yourdomain.com` → podgest-mcp worker
- [ ] Update Supabase Auth redirect URLs to production domain
- [ ] Update Google OAuth authorized redirect URIs
- [ ] Update all hardcoded URLs in codebase

#### 5.2 Spotify Submission
- [ ] Generate podcast cover art (3000x3000px, square)
- [ ] Upload cover art to Supabase Storage (`digests/cover.jpg`)
- [ ] Update RSS feed to include cover art URL
- [ ] Submit RSS feed to Spotify for Podcasters
- [ ] Set visibility to "Not searchable" (private)
- [ ] Wait for approval (24-48 hours)

#### 5.3 Resilience
- [ ] Deepgram fallback if Modal GPU issues persist
- [x] Watchdog cron for automatic retry of missed runs
- [ ] Error notification (email or Slack)

#### 5.4 Observability & Tracing

**Problem:** Logs are currently scattered across 5+ dashboards (Cloudflare, Modal, Supabase, SuperMemory, ElevenLabs). When something fails, it's hard to trace what happened.

**Solution:** Centralized logging with distributed tracing using natural trace IDs.

##### Recommended Stack

| Component | Purpose | Why |
|-----------|---------|-----|
| **Axiom** | Central log aggregation | Free tier, native Cloudflare integration, fast queries |
| **OpenTelemetry** | Distributed tracing | Industry standard, works with Axiom |
| **Sentry** | Error tracking | Automatic error capture, Cloudflare integration |
| **Supabase table** | Cost tracking | Custom `operation_costs` table for per-user billing |

##### Natural Trace IDs

Instead of generating random trace IDs, use the natural identifiers that flow through the system:

| Pipeline | Trace ID | Follows |
|----------|----------|---------|
| **Ingestion** | `episode_id` | RSS poll → transcription → topics → embedding |
| **Digest** | `digest_id` | Trigger → script → TTS → publish |
| **MCP Query** | `request_id` | Auth → tool call → response |

##### Structured Log Schema

All services should emit logs in this format:

```json
{
  "timestamp": "2026-01-16T22:00:00Z",
  "level": "info|warn|error",
  "service": "podgest-api|podgest-mcp|modal-transcribe|modal-tts",
  "trace_id": "episode_id or digest_id",
  "span": "rss_poll|transcription|topic_extraction|embedding|script_gen|tts",
  "user_id": "uuid",
  "event": "started|completed|failed",
  "duration_ms": 1234,
  "metadata": { },
  "cost_usd": 0.05
}
```

##### Ingestion Pipeline Tracing

```
trace_id = episode_id

┌─────────────────────────────────────────────────────────────────────────────┐
│  Episode Lifecycle (single trace)                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. rss_poll.episode_found                                                  │
│     └─ feed_url, episode_guid, title                                        │
│                                                                             │
│  2. transcription.started                                                   │
│     └─ modal_job_id, audio_url, audio_duration_estimate                     │
│                                                                             │
│  3. transcription.completed | transcription.failed                          │
│     └─ word_count, language, processing_time_ms, cost_usd                   │
│                                                                             │
│  4. topic_extraction.started                                                │
│     └─ transcript_length                                                    │
│                                                                             │
│  5. topic_extraction.completed                                              │
│     └─ topics_count, themes_count, claude_tokens_used, cost_usd             │
│                                                                             │
│  6. embedding.started                                                       │
│     └─ chunk_count                                                          │
│                                                                             │
│  7. embedding.completed                                                     │
│     └─ supermemory_doc_id, cost_usd                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

##### Digest Pipeline Tracing

```
trace_id = digest_id

┌─────────────────────────────────────────────────────────────────────────────┐
│  Digest Lifecycle (single trace)                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. digest.triggered                                                        │
│     └─ user_id, hours_back, eligible_episodes_count                         │
│                                                                             │
│  2. script_generation.started                                               │
│     └─ episode_ids[], target_length_minutes                                 │
│                                                                             │
│  3. script_generation.completed                                             │
│     └─ word_count, topics_covered[], claude_tokens_used, cost_usd           │
│                                                                             │
│  4. tts.started                                                             │
│     └─ modal_job_id, script_length_chars, voice_id                          │
│                                                                             │
│  5. tts.completed | tts.failed                                              │
│     └─ audio_duration_seconds, audio_url, elevenlabs_chars, cost_usd        │
│                                                                             │
│  6. digest.published                                                        │
│     └─ rss_updated, audio_size_bytes                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

##### Cost Tracking Table

```sql
CREATE TABLE public.operation_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id),
  trace_id TEXT NOT NULL,           -- episode_id or digest_id
  service TEXT NOT NULL,            -- modal, elevenlabs, claude, supermemory
  operation TEXT NOT NULL,          -- transcription, tts, summarization, embedding
  units_used DECIMAL,               -- seconds, characters, tokens, etc.
  unit_type TEXT,                   -- gpu_seconds, characters, tokens
  cost_usd DECIMAL(10, 6),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_costs_user_date ON public.operation_costs(user_id, created_at);
```

##### Alerting Rules

| Alert | Condition | Channel |
|-------|-----------|---------|
| Transcription stuck | No completion webhook > 30 min | Slack/Email |
| TTS failed | Status = failed | Slack/Email |
| Digest not generated | User scheduled time passed, no digest | Slack/Email |
| High cost spike | Daily cost > 2x average | Email |
| Error rate spike | >5% errors in 1 hour | Slack |

##### Implementation Checklist

- [ ] Set up Axiom account and get API key
- [ ] Add Axiom integration to Cloudflare Workers
- [ ] Add structured logging to podgest-api worker
- [ ] Add structured logging to podgest-mcp worker
- [ ] Add logging webhook from Modal to Axiom
- [ ] Create `operation_costs` table in Supabase
- [ ] Add cost logging to each operation
- [ ] Set up Sentry for error tracking
- [ ] Configure alerting rules in Axiom
- [ ] Create cost dashboard (simple Supabase query or Axiom dashboard)

#### 5.5 Documentation
- [ ] User onboarding guide
- [ ] Adding new podcast subscriptions
- [ ] Troubleshooting guide

### Phase 6: Future Enhancements

#### 6.1 Transcription Strategy
Modal-based transcription is the primary (and only) transcription method.

**Cost:** ~$0.05-0.15/episode (GPU time on Modal A10G)

**Why not ListenNotes?**
- PRO tier costs $200/month just for transcript access
- Not cost-effective for personal use (<100 episodes/month)
- Modal is pay-per-use with no monthly commitment

**Optional Future Optimization:**
- Check RSS `<podcast:transcript>` tag first (Podcasting 2.0 standard, ~5% adoption)
- Only fall back to Modal if no transcript in RSS

**ListenNotes FREE tier** (300 req/month) available for:
- Episode search/discovery (enhance MCP)
- Podcast metadata enrichment
- Not used for transcripts

#### 6.2 MCP Enhancements (Completed)
- [x] iOS deep links for Spotify/Apple Podcasts (open apps directly, no browser)
- [x] Accurate podcast name extraction from ListenNotes aggregated feeds
- [x] Direct audio playback URLs
- [ ] Episode chapter markers (if available in RSS)
- [ ] Speaker diarization data (who said what)

#### 6.3 Digest Improvements
- [ ] Configurable digest lengths (5/10/15/30 min presets)
- [ ] Conversational two-host format (requires ElevenLabs enterprise)
- [ ] Topic filtering (e.g., "skip politics today")
- [ ] Priority podcasts get more airtime

---

## Spotify Submission Guide

> **Note:** Wait until production domain is configured before submitting to Spotify. The RSS feed URL is permanent.

### Prerequisites
1. Custom domain configured and working
2. Podcast cover art (3000x3000px square, JPEG/PNG, <500KB)
3. At least one digest episode generated

### RSS Feed URL (Production)
```
https://api.podgest.yourdomain.com/feed/{userId}
```

### Submission Steps

1. **Go to Spotify for Podcasters**
   - https://podcasters.spotify.com
   - Sign in with Spotify account

2. **Add Your Podcast**
   - Click "Get Started" → "I have a podcast"
   - Paste your RSS feed URL

3. **Verify Ownership**
   - Spotify shows preview of your podcast
   - Confirm the details are correct

4. **Fill in Details**
   | Field | Value |
   |-------|-------|
   | Name | Podgest Daily |
   | Description | Your personalized daily podcast digest - AI-curated summaries from your favorite shows |
   | Category | News > Daily News |
   | Language | English |
   | Explicit | No |

5. **Set Visibility**
   - Choose **"Not searchable"** to keep it private
   - Only people with the direct link can find it

6. **Submit & Wait**
   - Spotify reviews within 24-48 hours
   - You'll receive email confirmation

### Cover Art Requirements
- **Size:** 3000x3000px (minimum 1400x1400)
- **Format:** JPEG or PNG
- **File size:** Under 500KB
- **Content:** No explicit imagery, readable at small sizes

---

## Design Decisions (Resolved)

| Question | Decision |
|----------|----------|
| **Digest length** | Fixed at 5 minutes for now (Cloudflare Worker limits); configurable preset lengths (5/10/15/30) planned for future |
| **TTS generation** | Modal handles ElevenLabs API calls (no Worker timeout issues) |
| **Podcast priority** | Weighted priorities (1-10) per subscription; higher = more airtime in digest |
| **Skip episodes** | Not for now; may add later |
| **Real-time vs batch** | Batch (overnight) — no real-time digest |
| **Transcript access** | MCP only — no need for transcripts in web UI |
| **Episode deduplication** | Episodes covered in last 7 days are excluded from new digests |
| **ListenNotes feeds** | Original podcast names extracted from episode descriptions for accurate citations |

## Working Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/poll` | POST | Trigger RSS polling for all subscriptions |
| `/api/generate-digest` | POST | Generate a digest (body: `{user_id, hours_back}`) — returns immediately, audio generated async |
| `/api/scheduled-digest` | POST | Check all users and generate digests for those at their scheduled time |
| `/api/extract-topics` | POST | Manually extract topics for an episode (body: `{episode_id}`) |
| `/api/embed-content` | POST | Manually embed episode in SuperMemory (body: `{episode_id}`) |
| `/api/daily-cron` | POST | Triggered by pg_cron, runs full daily workflow |
| `/api/webhooks/modal` | POST | Modal transcription callback |
| `/api/webhooks/tts` | POST | Modal TTS completion callback |
| `/feed/{userId}` | GET | RSS feed for Spotify/podcatchers |

**Base URL:** `https://podgest-api.pztest.workers.dev`

**Example RSS Feed:**
```
https://podgest-api.pztest.workers.dev/feed/18f513bd-8ecf-4922-84b7-4ab7c7cc14df
```

### MCP Server (Fully Remote)

**Base URL:** `https://podgest-mcp.pztest.workers.dev`

| Tool | Description |
|------|-------------|
| `search_podcasts` | Semantic search across all transcripts (SuperMemory) |
| `get_episode` | Episode details + signed URL for full transcript |
| `compare_takes` | Cross-podcast perspectives on a topic |
| `list_podcasts` | List user's subscriptions |
| `recent_episodes` | Recent episodes across subscriptions |
| `listen_to_episode` | Get iOS deep links (Spotify/Apple Podcasts apps) + direct audio URL |

**Auth Setup (one-time):**
```bash
cd apps/mcp-server/auth-cli && node index.js
```
This opens browser for Google OAuth, generates an API key, and updates `.cursor/mcp.json` automatically.

**Cursor Config Format:** `.cursor/mcp.json`
```json
{
  "mcpServers": {
    "podgest": {
      "url": "https://podgest-mcp.pztest.workers.dev/sse",
      "headers": {
        "Authorization": "Bearer pk_YOUR_API_KEY"
      }
    }
  }
}
```

### Modal Endpoints

| Endpoint | Description |
|----------|-------------|
| `https://ptzimmerman--podgest-transcribe-transcribe-web.modal.run` | Transcription (Whisper) |
| `https://ptzimmerman--podgest-transcribe-tts-web.modal.run` | Production TTS (ElevenLabs) |
| `https://ptzimmerman--podgest-transcribe-test-tts-web.modal.run` | Free test TTS (Edge TTS) |

## Open Questions

_(None currently — revisit as we build)_

---

## References

- [Supabase pg_cron](https://supabase.com/docs/guides/database/extensions/pg_cron) - Database cron scheduling
- [ElevenLabs API Docs](https://elevenlabs.io/docs) - Text-to-speech
- [Modal Documentation](https://modal.com/docs) - Serverless GPU compute
- [Deepgram API](https://developers.deepgram.com/) - Managed transcription (fallback)
- [SuperMemory API](https://docs.supermemory.ai) - Semantic memory layer
- [Supabase Documentation](https://supabase.com/docs) - Auth, DB, Storage, Edge Functions
- [MCP Protocol Spec](https://modelcontextprotocol.io) - Model Context Protocol
- [Spotify RSS Requirements](https://podcasters.spotify.com/support/articles/rss-feed-requirements)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) - Optimized Whisper implementation

---

## License

Private - All rights reserved.
