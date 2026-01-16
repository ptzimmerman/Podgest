# Podgest

> **Daily podcast digest + AI-powered Q&A for podcast content**

Transform hours of daily podcasts into a 5-minute professional news recap, and query all your podcast knowledge via Claude Desktop.

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
| **MCP Q&A** | Ask questions about any podcast content via Claude Desktop |
| **Multi-tenant** | Supports multiple users with isolated data |

---

## Phase 1: Daily Podcast Digest

### 1.1 Podcast Aggregation

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Feed Storage** | Supabase Postgres | User podcast subscriptions |
| **RSS Polling** | Inngest cron function | Check feeds every 30 min |
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
| **Orchestration** | Inngest | Event-driven workflow with retries |
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
| **Protocol** | MCP over SSE | Claude Desktop connection |
| **Memory Backend** | SuperMemory API | Semantic search across transcripts |
| **Auth** | Supabase JWT validation | User isolation |

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
| Workflow orchestration | Inngest (cloud) |
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
| **Inngest** | Cloud workflow orchestration; built-in retries, step resumability |
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
| **DIY job queue** | Use Inngest |

---

## Design Principles

### Pitfalls to Avoid

Based on experience with similar podcast ingestion systems, here are anti-patterns we're explicitly avoiding:

| Anti-Pattern | Problem | Our Approach |
|--------------|---------|--------------|
| **Monolithic functions** | Timeout limits, one failure breaks chain, hard to debug | Small, focused Inngest functions (<100 lines each) |
| **Polling for async jobs** | Wastes execution time, risks timeout, orphans jobs | Webhook callbacks from Modal |
| **DIY job queue in DB** | No retries, no dead-letter, race conditions | Inngest for workflow orchestration |
| **Full documents in Postgres** | Bloats DB, slows queries | Tiered storage (Postgres → S3 → SuperMemory) |
| **Tight coupling** | One failure cascades, no recovery | Event-driven architecture |
| **GPU workarounds** | CPU fallback is 5-10x slower | Proper GPU config + managed fallback (Deepgram) |

---

## Architecture

### Event-Driven Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                    PODGEST                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                         EVENT BUS (Inngest)                                 ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│        ▲                    ▲                    ▲                    ▲         │
│        │                    │                    │                    │         │
│  ┌─────┴─────┐       ┌──────┴──────┐      ┌──────┴──────┐      ┌──────┴──────┐ │
│  │   RSS     │       │  Transcribe │      │   Extract   │      │   Embed     │ │
│  │  Poller   │──────▶│   Worker    │─────▶│   Topics    │─────▶│   Worker    │ │
│  │  (cron)   │ emit  │  (Inngest)  │ emit │  (Inngest)  │ emit │  (Inngest)  │ │
│  └───────────┘       └─────────────┘      └─────────────┘      └─────────────┘ │
│                             │                                                   │
│                             ▼                                                   │
│                      ┌─────────────┐                                           │
│                      │    Modal    │◀─── webhook callback (not polling)        │
│                      │    (GPU)    │                                           │
│                      └─────────────┘                                           │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                              STORAGE LAYER                                  ││
│  ├──────────────────┬───────────────────────┬──────────────────────────────────┤│
│  │ Supabase Postgres│  Supabase Storage     │  SuperMemory                     ││
│  │ - Metadata       │  - Raw transcripts    │  - Semantic chunks               ││
│  │ - User data      │  - Generated audio    │  - Embeddings                    ││
│  │ - Events log     │  - Podcast artwork    │  - Search index                  ││
│  └──────────────────┴───────────────────────┴──────────────────────────────────┘│
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                           DAILY DIGEST PIPELINE                             ││
│  │                                                                             ││
│  │   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐     ││
│  │   │ Collect │──▶│ Cluster │──▶│ Script  │──▶│  TTS    │──▶│ Publish │     ││
│  │   │ Topics  │   │ Topics  │   │  Gen    │   │(11Labs) │   │   RSS   │     ││
│  │   └─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘     ││
│  │                                                                             ││
│  │   Triggered by: Inngest scheduled job @ 2 AM user-local-time               ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Why Inngest?

[Inngest](https://www.inngest.com/) is a serverless workflow engine that solves the hard problems:

```typescript
export const transcribeEpisode = inngest.createFunction(
  { id: "transcribe-episode", retries: 3 },
  { event: "episode.created" },
  async ({ event, step }) => {
    // Step 1: Call Modal (if this fails, Inngest retries automatically)
    const transcript = await step.run("transcribe", async () => {
      return await callModal(event.data.audioUrl);
    });
    
    // Step 2: Extract topics (if step 1 succeeded but step 2 fails, 
    // Inngest resumes from step 2, doesn't re-run step 1)
    const topics = await step.run("extract-topics", async () => {
      return await extractTopics(transcript);
    });
    
    // Step 3: Store in SuperMemory
    await step.run("embed", async () => {
      return await superMemory.add(transcript, topics);
    });
  }
);
```

**Benefits:**
- Built-in retries with exponential backoff
- Step-level resumability (partial failures don't restart from scratch)
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

The webhook handler is a simple endpoint that emits an Inngest event:

```typescript
// /api/webhooks/modal
export async function POST({ request }) {
  const { job_id, transcript } = await request.json();
  
  await inngest.send({
    name: "transcription.completed",
    data: { job_id, transcript }
  });
  
  return new Response("ok");
}
```

---

## Database Schema

> **Note:** Job orchestration is handled by **Inngest**, not a `scheduled_jobs` table. 
> Inngest provides built-in retries, dead-letter handling, and observability.

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
│   │   │   │       ├── inngest/+server.ts    # Inngest webhook endpoint
│   │   │   │       ├── feed/[userId]/+server.ts  # Podcast RSS feed
│   │   │   │       └── webhooks/
│   │   │   │           └── modal/+server.ts  # Modal completion callback
│   │   │   └── lib/
│   │   │       ├── supabase.ts
│   │   │       └── inngest.ts                # Inngest client
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
│   └── workflows/                    # Inngest workflow definitions
│       ├── src/
│       │   ├── client.ts             # Inngest client setup
│       │   ├── functions/
│       │   │   ├── poll-feeds.ts     # Cron: poll RSS feeds
│       │   │   ├── transcribe-episode.ts  # Event: episode.created
│       │   │   ├── extract-topics.ts      # Event: transcription.completed
│       │   │   ├── embed-content.ts       # Event: topics.extracted
│       │   │   └── generate-digest.ts     # Cron: daily digest per user
│       │   └── events.ts             # Event type definitions
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
| **Job orchestration** | Inngest workflows with step resumability |
| **Async compute** | Modal webhooks (not polling) |
| **Large content** | Supabase Storage for blobs, Postgres for metadata |
| **Search** | SuperMemory for semantic search + embeddings |
| **Retries** | Inngest automatic with exponential backoff |

---

## Implementation Roadmap

### Phase 1: Foundation & Infrastructure
- [x] Initialize monorepo (pnpm + turborepo)
- [x] Set up Supabase project with schema + storage buckets
- [x] Set up Inngest account and local dev environment
- [ ] Implement Google OAuth flow (skipped for now — using magic links)
- [x] Deploy Modal transcription endpoint with proper GPU config
- [x] Add initial podcast subscriptions via Supabase dashboard

### Phase 2: Ingestion Pipeline
- [x] **Verify SuperMemory** supports user_id, date, podcast filtering ✅ (containerTags + metadata filters)
- [x] `poll-feeds` Inngest cron function (every 15 min)
- [x] `transcribe-episode` Inngest function (triggered by episode.created)
- [x] Modal webhook callback endpoint (`/api/webhooks/modal`)
- [x] `extract-topics` function (Claude Sonnet 4) — auto-triggers after transcription completes
- [x] `embed-content` function (stores in SuperMemory) — auto-triggers after topic extraction
- [x] Deploy API (Cloudflare Workers) for Inngest + webhook endpoints
- [x] Register Inngest app URL in dashboard
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
- [x] Scheduled generation via Inngest cron (per-user timezone)
- [x] Free Edge TTS endpoint for testing (`test-audio` bucket)
- [ ] Conversational two-host format (future - requires ElevenLabs enterprise)

### Phase 4: Distribution + MCP ✅
- [x] RSS feed endpoint (`/feed/{userId}`) - Spotify/iTunes compatible
- [ ] Upload podcast cover art to Supabase Storage
- [ ] Submit personal feed to Spotify for Podcasters
- [x] MCP server implementation (Cloudflare Worker) - `https://podgest-mcp.pztest.workers.dev`
- [x] SuperMemory query integration in MCP tools (`search_podcasts`, `compare_takes`)
- [x] Local proxy for Claude Desktop connectivity
- [x] Cursor project MCP config (`.cursor/mcp.json`)
- [x] Test with Claude Desktop + Cursor
- [x] OAuth authentication flow (see Phase 4.1 below)

### Phase 4.1: OAuth Authentication (Multi-User Support) ✅

This sub-phase enables proper authentication so multiple users can use Podgest with their own isolated data.

#### Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Desktop │     │   Local Proxy   │     │   MCP Server    │     │    Supabase     │
│    / Cursor     │     │   (Node.js)     │     │  (Cloudflare)   │     │      Auth       │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │                       │
         │  1. MCP request       │                       │                       │
         │──────────────────────▶│                       │                       │
         │                       │                       │                       │
         │                       │  2. No token? Start   │                       │
         │                       │     local HTTP server │                       │
         │                       │     on localhost:9876 │                       │
         │                       │                       │                       │
         │  3. Opens browser     │                       │                       │
         │◀──────────────────────│                       │                       │
         │     to Supabase OAuth │                       │                       │
         │                       │                       │                       │
         │  4. User signs in ────────────────────────────────────────────────────▶│
         │     with Google       │                       │                       │
         │                       │                       │                       │
         │  5. Supabase redirects to localhost:9876/callback ◀───────────────────│
         │     with access_token in URL fragment         │                       │
         │                       │                       │                       │
         │                       │  6. Extract token,    │                       │
         │                       │     save to           │                       │
         │                       │     ~/.podgest/token  │                       │
         │                       │                       │                       │
         │                       │  7. Forward request   │                       │
         │                       │     with Bearer token │                       │
         │                       │──────────────────────▶│                       │
         │                       │                       │                       │
         │                       │                       │  8. Validate JWT      │
         │                       │                       │──────────────────────▶│
         │                       │                       │                       │
         │                       │                       │  9. Get user_id       │
         │                       │                       │◀──────────────────────│
         │                       │                       │                       │
         │                       │                       │  10. Query with       │
         │                       │                       │      user_id filter   │
         │                       │                       │      ↓                │
         │                       │                       │  SuperMemory:         │
         │                       │                       │    containerTags:[uid]│
         │                       │                       │  Supabase:            │
         │                       │                       │    user_id=eq.{uid}   │
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

**Part C: Local Proxy Updates** ✅
- [x] C1. Add OAuth flow to local proxy:
  - Check for token in `~/.podgest/token` on startup
  - If missing/expired, start localhost HTTP server on port 9876
  - Open browser to Supabase OAuth URL
  - Receive callback with token
  - Save token to `~/.podgest/token`
- [x] C2. Include `Authorization: Bearer {token}` header in all requests to remote MCP server
- [x] C3. Handle token refresh (Supabase tokens expire after 1 hour by default)

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

### Phase 5: Resilience & Polish
- [ ] Deepgram fallback if Modal GPU issues persist
- [ ] Inngest dead-letter handling and alerting
- [ ] Cost tracking dashboard (Modal, ElevenLabs, Claude usage)
- [ ] Error notification (email or Slack)
- [ ] End-to-end testing with real podcast load
- [ ] Documentation for adding new users

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
| `/api/inngest` | POST | Inngest webhook handler |
| `/api/webhooks/modal` | POST | Modal transcription callback |
| `/api/webhooks/tts` | POST | Modal TTS completion callback |
| `/feed/{userId}` | GET | RSS feed for Spotify/podcatchers |

**Base URL:** `https://podgest-api.pztest.workers.dev`

**Example RSS Feed:**
```
https://podgest-api.pztest.workers.dev/feed/18f513bd-8ecf-4922-84b7-4ab7c7cc14df
```

### MCP Server

**Base URL:** `https://podgest-mcp.pztest.workers.dev`

| Tool | Description |
|------|-------------|
| `search_podcasts` | Semantic search across all transcripts (SuperMemory) |
| `get_episode` | Episode details + signed URL for full transcript |
| `compare_takes` | Cross-podcast perspectives on a topic |
| `list_podcasts` | List user's subscriptions |
| `recent_episodes` | Recent episodes across subscriptions |

**Local Proxy (for Claude Desktop):** `apps/mcp-server/local-proxy/index.js`

**Cursor Config:** `.cursor/mcp.json` (project-specific MCP)

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

- [Inngest Documentation](https://www.inngest.com/docs) - Serverless workflow orchestration
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
