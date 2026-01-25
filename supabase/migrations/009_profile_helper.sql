-- Helper function to get all profiles (bypasses RLS)
CREATE OR REPLACE FUNCTION public.get_all_profiles()
RETURNS TABLE (
  id uuid,
  email text,
  timezone text,
  digest_time time,
  digest_length_minutes int
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT id, email, timezone, digest_time, digest_length_minutes FROM public.profiles;
$$;

-- Ensure profile exists for our user with correct settings
INSERT INTO public.profiles (id, email, timezone, digest_time, digest_length_minutes)
VALUES (
  '18f513bd-8ecf-4922-84b7-4ab7c7cc14df',
  'pete@example.com',
  'America/Mexico_City',
  '06:00:00',
  5
)
ON CONFLICT (id) DO UPDATE SET
  timezone = EXCLUDED.timezone,
  digest_time = EXCLUDED.digest_time,
  digest_length_minutes = EXCLUDED.digest_length_minutes;
