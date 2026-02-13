# Podgest

> **Your personal AI podcast digest - delivered daily to your favorite podcast app**

Podgest transforms your podcast subscriptions into personalized daily audio digests. Subscribe to unlimited podcasts, and each morning receive a professionally narrated summary of what matters most - delivered directly to Apple Podcasts, Spotify, or any podcast app via your personal RSS feed.

**Live at [dash.podgest.app](https://dash.podgest.app)**

---

## Architecture

```mermaid
flowchart TB
    subgraph User["👤 User"]
        PodcastApp["Podcast App<br/>(Apple/Spotify/etc)"]
        Dashboard["Web Dashboard<br/>dash.podgest.app"]
    end

    subgraph Cloudflare["☁️ Cloudflare"]
        API["podgest-api Worker"]
        MCP["podgest-mcp Worker"]
        Pages["Cloudflare Pages"]
        Queue["Cloudflare Queue"]
    end

    subgraph Supabase["🗄️ Supabase"]
        DB[(PostgreSQL)]
        Storage["Storage<br/>(audio files)"]
        Cron["pg_cron<br/>(daily triggers)"]
    end

    subgraph Modal["⚡ Modal (GPU)"]
        Whisper["faster-whisper<br/>Transcription"]
        TTS["OpenAI/ElevenLabs<br/>Text-to-Speech"]
    end

    subgraph AI["🤖 AI Services"]
        Claude["Claude<br/>(script generation)"]
        OpenAI["OpenAI<br/>(TTS & embeddings)"]
    end

    Dashboard --> Pages
    Pages --> API
    PodcastApp -->|RSS Feed| API
    
    Cron -->|6 AM daily| Queue
    Queue --> API
    
    API --> DB
    API --> Storage
    API --> Whisper
    API --> Claude
    API --> TTS
    
    Whisper --> Storage
    TTS --> Storage
    
    MCP --> DB
    MCP --> OpenAI
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **🎧 Personal RSS Feed** | Subscribe in any podcast app - Apple Podcasts, Spotify, Overcast, etc. |
| **⏱️ Configurable Length** | Choose digest length from 5-20 minutes based on your commute |
| **🕐 Custom Schedule** | Pick your delivery time and timezone (6 AM default) |
| **📡 Any Podcast RSS** | Add any podcast via RSS URL or browse popular feeds |
| **🔗 ListenNotes Integration** | Import your Listen Later playlist - auto-detects individual podcasts |
| **🎯 Smart Prioritization** | Less frequent podcasts (weekly shows) get priority over daily ones |
| **🔐 BYOK (Bring Your Own Keys)** | Use your own OpenAI, Anthropic, and ElevenLabs API keys |
| **🔒 Encrypted Storage** | API keys encrypted at rest with AES-256-GCM |
| **🧠 Semantic Memory** | All transcripts embedded via pgvector - search and query across your entire podcast history |
| **👥 Multi-tenant** | Each user has isolated data and personalized digests |
| **🎙️ MCP Server** | Query your podcast knowledge via Claude Desktop or Cursor |

---

## How It Works

1. **Subscribe** - Add your favorite podcasts via RSS URL in the dashboard
2. **Configure** - Set your preferred digest length (5-20 min), delivery time, and timezone  
3. **Add API Keys** - Provide your OpenAI and Anthropic keys (encrypted and stored securely)
4. **Listen** - Add your personal RSS feed to any podcast app
5. **Enjoy** - Wake up to a personalized audio digest every morning

### Daily Pipeline

```
6:00 AM (your timezone)
    │
    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Poll RSS   │────▶│ Transcribe  │────▶│  Extract    │
│   Feeds     │     │   (Modal)   │     │   Topics    │
└─────────────┘     └─────────────┘     └─────────────┘
                                               │
    ┌──────────────────────────────────────────┘
    │
    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Generate   │────▶│  Text-to-   │────▶│  Publish    │
│   Script    │     │   Speech    │     │  to RSS     │
│  (Claude)   │     │ (OpenAI)    │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Frontend** | React + TypeScript + Tailwind (Cloudflare Pages) |
| **API** | Cloudflare Workers (TypeScript) |
| **Database** | Supabase PostgreSQL |
| **Storage** | Supabase Storage (audio files) |
| **Scheduling** | pg_cron + Cloudflare Queues |
| **Transcription** | Modal (faster-whisper on GPU) |
| **Script Generation** | Claude (Anthropic) |
| **Text-to-Speech** | OpenAI TTS (ElevenLabs optional) |
| **Auth** | Supabase Auth (Magic Link) |

---

## Project Structure

```
podgest/
├── apps/
│   ├── web/                        # React dashboard (Cloudflare Pages)
│   │   └── src/
│   │       ├── pages/
│   │       │   ├── Settings.tsx     # API keys, digest prefs, manual generation
│   │       │   ├── Subscriptions.tsx # Podcast management
│   │       │   └── onboarding/      # First-time user setup
│   │       └── lib/
│   │           └── supabase.ts      # Supabase client
│   │
│   ├── worker/
│   │   └── podgest-api/             # Main API (Cloudflare Worker)
│   │       └── src/
│   │           ├── index.ts         # API endpoints, digest pipeline, RSS feed
│   │           └── user-keys.ts     # API key encryption/validation
│   │
│   └── mcp-server/                  # MCP Server (Cloudflare Worker)
│       └── src/
│           └── index.ts             # MCP protocol handler
│
├── modal/
│   ├── transcribe.py                # GPU transcription (faster-whisper)
│   └── tts.py                       # Text-to-speech generation
│
├── supabase/
│   └── migrations/                  # Database schema + RLS policies
│
├── docs/
│   └── IMPLEMENTATION.md            # Detailed design docs & implementation plan
│
└── .cursor/
    └── agents/                      # Reusable Cursor agents
        ├── security.md              # Security review agent
        ├── verification.md          # System verification agent
        └── ui.md                    # UI testing agent
```

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm
- Cloudflare account (Workers + Pages)
- Supabase project
- Modal account (for GPU transcription)

### Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |

Worker secrets (set via `wrangler secret put`):

| Secret | Description |
|--------|-------------|
| `API_KEY_ENCRYPTION_KEY` | AES-256 key for encrypting user API keys |
| `ADMIN_API_KEY` | Admin endpoint authentication |

### Development

```bash
# Install dependencies
pnpm install

# Run web dashboard locally
pnpm --filter web dev

# Deploy API worker
cd apps/worker/podgest-api && npx wrangler deploy

# Deploy web dashboard
cd apps/web && npm run build && npx wrangler pages deploy dist --project-name=podgest-web
```

## Documentation

- [Implementation Plan & Design Docs](docs/IMPLEMENTATION.md) - Detailed architecture, design decisions, roadmap
- [Security Agent](.cursor/agents/security.md) - Reusable security review configuration

---

## License

Private - All rights reserved.
