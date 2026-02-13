-- Add digest length setting to profiles
-- Allows users to choose how long their daily digest should be (5-20 minutes)

-- Add column if not exists
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS digest_length_minutes INTEGER DEFAULT 5;

-- Set default value for any NULL rows before adding constraint
UPDATE public.profiles SET digest_length_minutes = 5 WHERE digest_length_minutes IS NULL;

-- Set NOT NULL after ensuring all rows have values
ALTER TABLE public.profiles ALTER COLUMN digest_length_minutes SET NOT NULL;

-- Add constraint to ensure valid range (drop first if exists)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS digest_length_minutes_range;
ALTER TABLE public.profiles 
ADD CONSTRAINT digest_length_minutes_range 
CHECK (digest_length_minutes >= 5 AND digest_length_minutes <= 20);

COMMENT ON COLUMN public.profiles.digest_length_minutes IS 'Target length for daily digest in minutes (5-20)';
