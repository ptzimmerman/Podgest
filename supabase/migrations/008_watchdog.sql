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
