-- Fix the trigger function to use correct pg_net syntax
-- pg_net.http_post signature: http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)

CREATE OR REPLACE FUNCTION public.trigger_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  request_id bigint;
BEGIN
  -- Call the Cloudflare Worker endpoint using pg_net
  SELECT net.http_post(
    url := 'https://podgest-api.pztest.workers.dev/api/daily-cron',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) INTO request_id;
  
  RAISE NOTICE 'Daily digest triggered, request_id: %', request_id;
END;
$$;

-- Verify extension is enabled
SELECT * FROM pg_extension WHERE extname = 'pg_net';
