-- Phase 8.3: Search Functions
-- Semantic search functions for transcripts and newsletters using pgvector

-- =============================================================================
-- search_transcripts: Semantic search for podcast transcripts
-- =============================================================================

CREATE OR REPLACE FUNCTION search_transcripts(
  query_embedding vector(1536),
  match_user_id UUID,
  match_count INT DEFAULT 10,
  filter_episode_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  episode_id UUID,
  episode_title TEXT,
  podcast_title TEXT,
  chunk_text TEXT,
  chunk_index INT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    te.id,
    te.episode_id,
    e.title as episode_title,
    s.podcast_title,
    te.chunk_text,
    te.chunk_index,
    1 - (te.embedding <=> query_embedding) as similarity
  FROM transcript_embeddings te
  JOIN episodes e ON e.id = te.episode_id
  JOIN subscriptions s ON s.feed_url = e.feed_url AND s.user_id = match_user_id
  WHERE te.user_id = match_user_id
    AND (filter_episode_ids IS NULL OR te.episode_id = ANY(filter_episode_ids))
  ORDER BY te.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- =============================================================================
-- search_all_content: Combined search across transcripts and newsletters
-- =============================================================================

CREATE OR REPLACE FUNCTION search_all_content(
  query_embedding vector(1536),
  match_user_id UUID,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  content_type TEXT,
  content_id UUID,
  title TEXT,
  source TEXT,
  chunk_text TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  (
    -- Transcript results
    SELECT 
      'podcast'::TEXT as content_type,
      te.episode_id as content_id,
      e.title,
      s.podcast_title as source,
      te.chunk_text,
      1 - (te.embedding <=> query_embedding) as similarity
    FROM transcript_embeddings te
    JOIN episodes e ON e.id = te.episode_id
    JOIN subscriptions s ON s.feed_url = e.feed_url AND s.user_id = match_user_id
    WHERE te.user_id = match_user_id
  )
  UNION ALL
  (
    -- Newsletter results (will return empty until newsletters table is created)
    SELECT 
      'newsletter'::TEXT as content_type,
      ne.newsletter_id as content_id,
      COALESCE(ne.metadata->>'subject', 'Newsletter') as title,
      COALESCE(ne.metadata->>'sender_name', 'Unknown') as source,
      ne.chunk_text,
      1 - (ne.embedding <=> query_embedding) as similarity
    FROM newsletter_embeddings ne
    WHERE ne.user_id = match_user_id
  )
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- =============================================================================
-- search_newsletters: Search only newsletter content
-- =============================================================================

CREATE OR REPLACE FUNCTION search_newsletters(
  query_embedding vector(1536),
  match_user_id UUID,
  match_count INT DEFAULT 10,
  filter_newsletter_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  newsletter_id UUID,
  chunk_text TEXT,
  chunk_index INT,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ne.id,
    ne.newsletter_id,
    ne.chunk_text,
    ne.chunk_index,
    1 - (ne.embedding <=> query_embedding) as similarity
  FROM newsletter_embeddings ne
  WHERE ne.user_id = match_user_id
    AND (filter_newsletter_ids IS NULL OR ne.newsletter_id = ANY(filter_newsletter_ids))
  ORDER BY ne.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
