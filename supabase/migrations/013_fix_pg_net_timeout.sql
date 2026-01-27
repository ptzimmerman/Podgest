-- Migration 013: Fix pg_net timeout issue
-- Workflow takes ~30 seconds, so set 60s timeout for safety margin

-- Update trigger_daily_digest to use longer timeout (60 seconds)
CREATE OR REPLACE FUNCTION public.trigger_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  request_id bigint;
BEGIN
  -- Call the Cloudflare Worker endpoint using pg_net with 60s timeout
  -- Workflow does: RSS polling + Claude digest script + TTS trigger
  SELECT net.http_post(
    url := 'https://podgest-api.pztest.workers.dev/api/daily-cron'::text,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO request_id;
  
  RAISE NOTICE 'Daily digest triggered, request_id: %', request_id;
END;
$$;

-- Update watchdog to use longer timeout too
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
    -- No digest today - trigger generation with 60s timeout
    SELECT net.http_post(
      url := 'https://podgest-api.pztest.workers.dev/api/daily-cron'::text,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
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
