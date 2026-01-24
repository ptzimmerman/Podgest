-- Migration 004: Add script_text column and set up daily cron
-- Run this in Supabase Dashboard → SQL Editor

-- Step 1: Add script_text column to digests table for ElevenReader integration
ALTER TABLE public.digests ADD COLUMN IF NOT EXISTS script_text TEXT;

-- Step 2: Enable required extensions (if not already enabled)
-- Note: You may need to enable these in Dashboard → Database → Extensions first
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Step 3: Create a function to call our daily cron endpoint
CREATE OR REPLACE FUNCTION public.trigger_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  request_id bigint;
BEGIN
  -- Call the Cloudflare Worker endpoint using pg_net
  SELECT extensions.http_post(
    url := 'https://podgest-api.pztest.workers.dev/api/daily-cron'::text,
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb
  ) INTO request_id;
  
  RAISE NOTICE 'Daily digest triggered, request_id: %', request_id;
END;
$$;

-- Step 4: Schedule the daily digest at 6 AM Mexico City (12:00 UTC)
-- First, remove any existing schedule with the same name
SELECT cron.unschedule('daily-digest-6am') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'daily-digest-6am'
);

-- Then create the new schedule
SELECT cron.schedule(
  'daily-digest-6am',           -- job name
  '0 12 * * *',                 -- 12:00 UTC = 6:00 AM Mexico City (CST)
  $$SELECT public.trigger_daily_digest()$$
);

-- Verify the job was created
SELECT * FROM cron.job WHERE jobname = 'daily-digest-6am';
