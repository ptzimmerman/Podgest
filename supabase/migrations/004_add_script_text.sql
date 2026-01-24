-- Add script_text column to digests table for ElevenReader integration
ALTER TABLE digests ADD COLUMN IF NOT EXISTS script_text TEXT;

-- Enable pg_cron extension for reliable scheduling
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Create a function to call our daily cron endpoint
CREATE OR REPLACE FUNCTION trigger_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Call the Cloudflare Worker endpoint
  PERFORM net.http_post(
    url := 'https://podgest-api.pztest.workers.dev/api/daily-cron',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
END;
$$;

-- Schedule the daily digest at 6 AM Mexico City (12:00 UTC)
-- Note: pg_cron uses UTC
SELECT cron.schedule(
  'daily-digest-6am',
  '0 12 * * *',  -- 12:00 UTC = 6:00 AM Mexico City
  $$SELECT trigger_daily_digest()$$
);
