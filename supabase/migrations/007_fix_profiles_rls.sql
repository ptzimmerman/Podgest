-- Fix RLS on profiles table to allow service role access
-- and add helper functions for debugging

-- Ensure RLS is enabled but service role can bypass
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Allow service role to read all profiles (for cron job)
DROP POLICY IF EXISTS "Service role can read all profiles" ON public.profiles;
CREATE POLICY "Service role can read all profiles" ON public.profiles
  FOR SELECT
  TO service_role
  USING (true);

-- Allow service role to insert/update profiles
DROP POLICY IF EXISTS "Service role can manage profiles" ON public.profiles;
CREATE POLICY "Service role can manage profiles" ON public.profiles
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Helper function to get all profiles (bypasses RLS)
CREATE OR REPLACE FUNCTION public.get_all_profiles()
RETURNS TABLE (
  id uuid,
  email text,
  timezone text,
  digest_time time,
  digest_length_minutes int
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT id, email, timezone, digest_time, digest_length_minutes FROM public.profiles;
$$;

-- Watchdog function - checks if digest ran today and triggers if not
CREATE OR REPLACE FUNCTION public.watchdog_check_digest()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  today_date date := CURRENT_DATE;
  digest_count int;
  request_id bigint;
  result jsonb;
BEGIN
  -- Check if any digest was generated today
  SELECT COUNT(*) INTO digest_count
  FROM public.digests
  WHERE digest_date = today_date;
  
  IF digest_count = 0 THEN
    -- No digest today - trigger generation
    SELECT net.http_post(
      url := 'https://podgest-api.pztest.workers.dev/api/daily-cron',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    ) INTO request_id;
    
    result := jsonb_build_object(
      'status', 'triggered',
      'reason', 'no digest found for today',
      'date', today_date,
      'request_id', request_id
    );
  ELSE
    result := jsonb_build_object(
      'status', 'ok',
      'reason', 'digest already exists for today',
      'date', today_date,
      'digest_count', digest_count
    );
  END IF;
  
  RETURN result;
END;
$$;

-- Schedule watchdog to run every hour as backup
SELECT cron.unschedule('watchdog-hourly') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'watchdog-hourly'
);

SELECT cron.schedule(
  'watchdog-hourly',
  '30 * * * *',  -- Run at :30 past every hour
  $$SELECT public.watchdog_check_digest()$$
);
