-- Phase 8.2: pgvector Embeddings Tables
-- Replaces SuperMemory with Supabase-native pgvector for semantic search

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- Transcript Embeddings Table
-- =============================================================================

CREATE TABLE public.transcript_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,
  
  -- Chunk metadata
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  word_count INTEGER,
  
  -- The embedding vector (1536 dimensions for text-embedding-3-small)
  embedding vector(1536),
  
  -- Metadata for flexible filtering
  metadata JSONB DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user filtering
CREATE INDEX transcript_embeddings_user_id_idx 
  ON public.transcript_embeddings(user_id);

-- Composite index for user + episode filtering
CREATE INDEX transcript_embeddings_user_episode_idx 
  ON public.transcript_embeddings(user_id, episode_id);

-- Index for fast similarity search using IVFFlat
-- Note: IVFFlat requires the table to have some data before creating the index
-- For initial setup, we create it anyway; it will be used once data is added
CREATE INDEX transcript_embeddings_embedding_idx ON public.transcript_embeddings 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- RLS: users can only access their own embeddings
ALTER TABLE public.transcript_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access their own embeddings" ON public.transcript_embeddings
  FOR ALL USING (auth.uid() = user_id);

-- Service role bypass for pipeline operations
CREATE POLICY "Service role full access" ON public.transcript_embeddings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- Newsletter Embeddings Table (same structure as transcripts)
-- =============================================================================

CREATE TABLE public.newsletter_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  newsletter_id UUID, -- Will reference newsletters table when created
  
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  word_count INTEGER,
  
  embedding vector(1536),
  
  metadata JSONB DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user filtering
CREATE INDEX newsletter_embeddings_user_id_idx 
  ON public.newsletter_embeddings(user_id);

-- Composite index for user + newsletter filtering
CREATE INDEX newsletter_embeddings_user_newsletter_idx 
  ON public.newsletter_embeddings(user_id, newsletter_id);

-- Index for fast similarity search using IVFFlat
CREATE INDEX newsletter_embeddings_embedding_idx ON public.newsletter_embeddings 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- RLS: users can only access their own newsletter embeddings
ALTER TABLE public.newsletter_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access their own newsletter embeddings" ON public.newsletter_embeddings
  FOR ALL USING (auth.uid() = user_id);

-- Service role bypass for pipeline operations
CREATE POLICY "Service role full access" ON public.newsletter_embeddings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
