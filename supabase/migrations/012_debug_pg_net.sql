-- Debug helper to check pg_net responses and pg_cron history

-- Check pg_net request responses
CREATE OR REPLACE FUNCTION public.check_http_responses()
RETURNS TABLE (
  id bigint,
  status_code int,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    id,
    status_code,
    left(content::text, 500) as content,
    timed_out,
    error_msg,
    created
  FROM net._http_response
  ORDER BY created DESC
  LIMIT 20;
$$;

-- Check pg_cron job run history  
CREATE OR REPLACE FUNCTION public.check_cron_history()
RETURNS TABLE (
  runid bigint,
  jobid bigint,
  job_pid int,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    runid,
    jobid,
    job_pid,
    database,
    username,
    command,
    status,
    return_message,
    start_time,
    end_time
  FROM cron.job_run_details
  ORDER BY start_time DESC
  LIMIT 20;
$$;

-- Simple test function to verify pg_net is working
CREATE OR REPLACE FUNCTION public.test_pg_net()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  request_id bigint;
BEGIN
  -- Try a simple HTTP request to httpbin (or our own endpoint)
  SELECT net.http_post(
    url := 'https://podgest-api.pztest.workers.dev/api/daily-cron',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"test": true}'::jsonb
  ) INTO request_id;
  
  RETURN jsonb_build_object(
    'status', 'queued',
    'request_id', request_id,
    'note', 'Check check_http_responses() in ~5 seconds to see result'
  );
END;
$$;
