-- Fix RLS on digests table for service role access
ALTER TABLE public.digests ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
DROP POLICY IF EXISTS "Service role full access" ON public.digests;
CREATE POLICY "Service role full access" ON public.digests
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Also fix profiles RLS  
DROP POLICY IF EXISTS "Service role full access" ON public.profiles;
CREATE POLICY "Service role full access" ON public.profiles
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- And episodes
DROP POLICY IF EXISTS "Service role full access" ON public.episodes;
CREATE POLICY "Service role full access" ON public.episodes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- And transcriptions
DROP POLICY IF EXISTS "Service role full access" ON public.transcriptions;
CREATE POLICY "Service role full access" ON public.transcriptions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- And subscriptions
DROP POLICY IF EXISTS "Service role full access" ON public.subscriptions;
CREATE POLICY "Service role full access" ON public.subscriptions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
