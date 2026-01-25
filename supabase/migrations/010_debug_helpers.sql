-- Get digest count for debugging
CREATE OR REPLACE FUNCTION public.get_digest_count()
RETURNS int
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(*)::int FROM public.digests;
$$;

-- Get all digests (bypasses RLS)
CREATE OR REPLACE FUNCTION public.get_all_digests()
RETURNS TABLE (
  id uuid,
  user_id uuid,
  digest_date date,
  status text,
  episodes_included uuid[],
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT id, user_id, digest_date, status, episodes_included, created_at FROM public.digests ORDER BY created_at DESC;
$$;
