-- Migration 014: Increase pg_net timeout to 60 seconds
-- Workflow takes ~30s, need safety margin

CREATE OR REPLACE FUNCTION public.trigger_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  request_id bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://podgest-api.pztest.workers.dev/api/daily-cron'::text,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO request_id;
  
  RAISE NOTICE 'Daily digest triggered, request_id: %', request_id;
END;
$$;

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
  SELECT COUNT(*) INTO digest_count
  FROM public.digests
  WHERE digest_date = today_date;
  
  IF digest_count = 0 THEN
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
