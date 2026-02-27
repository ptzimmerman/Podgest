-- Migration 025: Add admin API key to pg_cron functions
--
-- Store the admin API key in Supabase vault and update cron functions 
-- to include it in HTTP headers when calling the API.

-- Store admin key in vault
-- Insert your admin API key into the vault. Generate one with: openssl rand -hex 32
-- Then run: SELECT vault.create_secret('<YOUR_ADMIN_API_KEY>', 'admin_api_key', 'Admin API key for authenticating pg_cron calls to podgest-api');
-- This must match the ADMIN_API_KEY secret set on the Cloudflare Worker.

-- Update the daily digest trigger to include admin key
CREATE OR REPLACE FUNCTION public.trigger_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  request_id bigint;
  admin_key text;
BEGIN
  -- Retrieve admin key from vault
  SELECT decrypted_secret INTO admin_key
  FROM vault.decrypted_secrets
  WHERE name = 'admin_api_key'
  LIMIT 1;

  SELECT net.http_post(
    url := 'https://api.podgest.app/api/daily-cron'::text,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Admin-Key', admin_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) INTO request_id;
  
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

-- Update the per-user watchdog to include admin key
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
  admin_key text;
BEGIN
  -- Retrieve admin key from vault
  SELECT decrypted_secret INTO admin_key
  FROM vault.decrypted_secrets
  WHERE name = 'admin_api_key'
  LIMIT 1;

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
    SELECT net.http_post(
      url := 'https://api.podgest.app/api/requeue-users'::text,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Admin-Key', admin_key
      ),
      body := missing_users,
      timeout_milliseconds := 10000
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
