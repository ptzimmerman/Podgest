-- Fix Supabase security advisor: rls_disabled_in_public
-- episodes and transcriptions had service_role policies (011) but RLS was never enabled.
-- topic_extractions had no RLS at all.

ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_extractions ENABLE ROW LEVEL SECURITY;

-- topic_extractions: service role only (backend pipeline)
CREATE POLICY "Service role full access" ON public.topic_extractions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can read episodes from their subscribed feeds
CREATE POLICY "Users read episodes from subscribed feeds" ON public.episodes
  FOR SELECT
  TO authenticated
  USING (
    feed_url IN (
      SELECT feed_url FROM public.subscriptions
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- Authenticated users can read transcriptions for those episodes
CREATE POLICY "Users read transcriptions for subscribed episodes" ON public.transcriptions
  FOR SELECT
  TO authenticated
  USING (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      INNER JOIN public.subscriptions s ON s.feed_url = e.feed_url
      WHERE s.user_id = auth.uid() AND s.is_active = true
    )
  );

-- Authenticated users can read topic extractions for those transcriptions
CREATE POLICY "Users read topic extractions for subscribed episodes" ON public.topic_extractions
  FOR SELECT
  TO authenticated
  USING (
    transcription_id IN (
      SELECT t.id FROM public.transcriptions t
      INNER JOIN public.episodes e ON e.id = t.episode_id
      INNER JOIN public.subscriptions s ON s.feed_url = e.feed_url
      WHERE s.user_id = auth.uid() AND s.is_active = true
    )
  );
