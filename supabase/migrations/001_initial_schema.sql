-- ============================================
-- PODGEST INITIAL SCHEMA
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS & AUTH
-- ============================================

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  timezone TEXT DEFAULT 'America/Los_Angeles',
  digest_time TIME DEFAULT '06:00:00',
  digest_length_minutes INTEGER DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================
-- PODCAST SUBSCRIPTIONS
-- ============================================

CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  podcast_title TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  artwork_url TEXT,
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
  is_active BOOLEAN DEFAULT true,
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, feed_url)
);

CREATE INDEX idx_subscriptions_user ON public.subscriptions(user_id);
CREATE INDEX idx_subscriptions_active ON public.subscriptions(is_active) WHERE is_active = true;

-- ============================================
-- EPISODES (shared across users)
-- ============================================

CREATE TABLE public.episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_url TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  audio_url TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(feed_url, guid)
);

CREATE INDEX idx_episodes_feed ON public.episodes(feed_url);
CREATE INDEX idx_episodes_published ON public.episodes(published_at DESC);

-- ============================================
-- TRANSCRIPTIONS
-- ============================================

CREATE TABLE public.transcriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  transcript_storage_path TEXT,
  supermemory_doc_id TEXT,
  word_count INTEGER,
  language TEXT DEFAULT 'en',
  processing_time_ms INTEGER,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_transcriptions_status ON public.transcriptions(status);
CREATE INDEX idx_transcriptions_episode ON public.transcriptions(episode_id);

-- ============================================
-- TOPIC EXTRACTIONS
-- ============================================

CREATE TABLE public.topic_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transcription_id UUID REFERENCES public.transcriptions(id) ON DELETE CASCADE UNIQUE NOT NULL,
  topics JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- DAILY DIGESTS
-- ============================================

CREATE TABLE public.digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  digest_date DATE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'completed', 'failed')),
  topic_clusters JSONB,
  script_storage_path TEXT,
  audio_storage_path TEXT,
  audio_url TEXT,
  duration_seconds INTEGER,
  episodes_included UUID[] DEFAULT '{}',
  total_source_minutes INTEGER,
  processing_time_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, digest_date)
);

CREATE INDEX idx_digests_user ON public.digests(user_id);
CREATE INDEX idx_digests_date ON public.digests(digest_date DESC);

-- ============================================
-- MCP TOKENS
-- ============================================

CREATE TABLE public.mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  token_hash TEXT NOT NULL,
  name TEXT,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mcp_tokens_user ON public.mcp_tokens(user_id);

-- ============================================
-- EVENT LOG (for debugging/audit)
-- ============================================

CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- Profiles: users can only access their own
CREATE POLICY "Users own their profile" ON public.profiles
  FOR ALL USING (auth.uid() = id);

-- Subscriptions: users can only access their own
CREATE POLICY "Users own their subscriptions" ON public.subscriptions
  FOR ALL USING (auth.uid() = user_id);

-- Digests: users can only access their own
CREATE POLICY "Users own their digests" ON public.digests
  FOR ALL USING (auth.uid() = user_id);

-- MCP Tokens: users can only access their own
CREATE POLICY "Users own their tokens" ON public.mcp_tokens
  FOR ALL USING (auth.uid() = user_id);

-- Events: users can only view their own
CREATE POLICY "Users can view their events" ON public.events
  FOR SELECT USING (auth.uid() = user_id);

-- Episodes and transcriptions: no RLS (accessed via service role)
-- They're shared resources, backend uses service role key
