-- Migration 020: Add watchdog cron job for digest generation
-- The main cron times out during RSS polling before reaching digest generation
-- This watchdog runs 15 minutes later to catch any missed digests

-- Schedule watchdog at 6:15 AM CDMX (12:15 UTC)
SELECT cron.schedule(
  'digest-watchdog-615am',
  '15 12 * * *',
  $$SELECT public.watchdog_check_digest()$$
);

-- Also add a second watchdog at 6:30 AM in case the first one misses
SELECT cron.schedule(
  'digest-watchdog-630am', 
  '30 12 * * *',
  $$SELECT public.watchdog_check_digest()$$
);
