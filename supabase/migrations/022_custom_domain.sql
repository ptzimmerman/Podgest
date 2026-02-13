-- Migration 022: Update API URLs to custom domain
-- 
-- Changes all pg_net HTTP calls from podgest-api.pztest.workers.dev to api.podgest.app

-- Update watchdog function with new domain
CREATE OR REPLACE FUNCTION public.watchdog_check_digests_per_user()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  today_date date := CURRENT_DATE;
  missing_users jsonb;
  user_count int;
  request_id bigint;
  result jsonb;
BEGIN
  -- Find users who should have a digest today but don't
  SELECT jsonb_agg(
    jsonb_build_object(
      'user_id', p.id,
      'email', p.email
    )
  ), COUNT(*)
  INTO missing_users, user_count
  FROM public.profiles p
  LEFT JOIN public.digests d ON d.user_id = p.id 
    AND d.digest_date = today_date
  WHERE d.id IS NULL;
  
  IF user_count > 0 AND missing_users IS NOT NULL THEN
    -- Re-queue missing users via the async API
    SELECT net.http_post(
      url := 'https://api.podgest.app/api/requeue-users'::text,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := missing_users,
      timeout_milliseconds := 10000  -- Short timeout, just queuing
    ) INTO request_id;
    
    result := jsonb_build_object(
      'status', 'requeued',
      'date', today_date,
      'users_missing', user_count,
      'users', missing_users,
      'request_id', request_id
    );
    
    RAISE NOTICE 'Watchdog: % users missing digest, re-queued', user_count;
  ELSE
    result := jsonb_build_object(
      'status', 'all_complete',
      'date', today_date,
      'message', 'All users have digests for today'
    );
  END IF;
  
  -- Log the watchdog run
  INSERT INTO public.pipeline_logs (run_id, step, status, details)
  VALUES (
    gen_random_uuid(),
    'watchdog_check',
    CASE WHEN user_count > 0 THEN 'triggered' ELSE 'ok' END,
    result
  );
  
  RETURN result;
END;
$$;

-- Update main trigger function with new domain
CREATE OR REPLACE FUNCTION public.trigger_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  request_id bigint;
BEGIN
  -- Use /api/dispatch for async queue, falls back to legacy if queue not configured
  SELECT net.http_post(
    url := 'https://api.podgest.app/api/daily-cron'::text,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000  -- Short timeout, dispatcher is fast
  ) INTO request_id;
  
  -- Log the trigger
  INSERT INTO public.pipeline_logs (run_id, step, status, details)
  VALUES (
    gen_random_uuid(),
    'cron_trigger',
    'dispatched',
    jsonb_build_object('request_id', request_id, 'timestamp', now())
  );
  
  RAISE NOTICE 'Daily digest dispatched, request_id: %', request_id;
END;
$$;

COMMENT ON FUNCTION public.watchdog_check_digests_per_user() IS 
'Per-user watchdog that checks for missing digests and re-queues only the affected users.
Uses the async queue system for efficient processing. Updated to use api.podgest.app.';

COMMENT ON FUNCTION public.trigger_daily_digest() IS 
'Main cron trigger that dispatches digest generation to the async queue.
Each user is processed independently with their own timeout and retry. Updated to use api.podgest.app.';
