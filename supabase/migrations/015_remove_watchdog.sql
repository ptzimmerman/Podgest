-- Remove the watchdog cron job that was triggering digests at unexpected times
-- (Safe to run even if already removed)

DO $$
BEGIN
  -- Only unschedule if the job exists
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'watchdog-hourly') THEN
    PERFORM cron.unschedule('watchdog-hourly');
  END IF;
END $$;

-- Optionally drop the function (commented out in case you want to keep it for manual use)
-- DROP FUNCTION IF EXISTS public.watchdog_check_digest();
