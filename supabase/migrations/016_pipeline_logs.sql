-- Pipeline observability logs
-- Tracks each step of the daily cron pipeline for debugging

CREATE TABLE IF NOT EXISTS public.pipeline_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL,  -- Groups all logs from a single cron run
  step TEXT NOT NULL,    -- e.g., 'cron_start', 'poll_start', 'poll_episode', 'digest_start', etc.
  status TEXT NOT NULL DEFAULT 'started',  -- 'started', 'completed', 'failed'
  details JSONB,         -- Step-specific details
  error TEXT,            -- Error message if failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying recent runs
CREATE INDEX IF NOT EXISTS pipeline_logs_run_id ON public.pipeline_logs(run_id);
CREATE INDEX IF NOT EXISTS pipeline_logs_created_at ON public.pipeline_logs(created_at DESC);

-- RLS - service role only
ALTER TABLE public.pipeline_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage pipeline_logs" ON public.pipeline_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Helper function to get recent pipeline runs
CREATE OR REPLACE FUNCTION public.get_recent_pipeline_runs(limit_count INT DEFAULT 10)
RETURNS TABLE (
  run_id UUID,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  status TEXT,
  steps_count INT,
  errors_count INT
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    run_id,
    MIN(created_at) as started_at,
    MAX(created_at) as completed_at,
    CASE 
      WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0 THEN 'failed'
      WHEN COUNT(*) FILTER (WHERE step = 'cron_complete' AND status = 'completed') > 0 THEN 'completed'
      ELSE 'running'
    END as status,
    COUNT(*)::INT as steps_count,
    COUNT(*) FILTER (WHERE status = 'failed')::INT as errors_count
  FROM public.pipeline_logs
  GROUP BY run_id
  ORDER BY MIN(created_at) DESC
  LIMIT limit_count;
$$;

-- Helper to get logs for a specific run
CREATE OR REPLACE FUNCTION public.get_pipeline_run_logs(p_run_id UUID)
RETURNS TABLE (
  id BIGINT,
  step TEXT,
  status TEXT,
  details JSONB,
  error TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT id, step, status, details, error, created_at
  FROM public.pipeline_logs
  WHERE run_id = p_run_id
  ORDER BY created_at ASC;
$$;
