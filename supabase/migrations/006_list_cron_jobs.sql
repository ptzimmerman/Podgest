-- Helper function to list cron jobs
CREATE OR REPLACE FUNCTION public.list_cron_jobs()
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  command text,
  active boolean
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT jobid, jobname, schedule, command, active FROM cron.job;
$$;
