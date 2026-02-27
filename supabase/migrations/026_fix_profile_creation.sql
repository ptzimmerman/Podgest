-- Migration 026: Fix new user profile creation
--
-- The profiles.digest_length_minutes column has DEFAULT 30 (from 001_initial_schema)
-- but a CHECK constraint restricting values to 5-20 (from 023_digest_length_setting).
-- This causes "Database error saving new user" when the trigger inserts without
-- explicitly setting digest_length_minutes.
--
-- Fix: Update the column default to 5 and update the trigger to be explicit.

-- Fix the column default
ALTER TABLE public.profiles ALTER COLUMN digest_length_minutes SET DEFAULT 5;

-- Update the trigger function to explicitly include all required columns
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, timezone, digest_time, digest_length_minutes)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    'America/Chicago',  -- Default timezone (Central)
    '06:00:00',         -- Default digest time (6 AM)
    5                   -- Default digest length (5 minutes)
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = COALESCE(EXCLUDED.display_name, profiles.display_name);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
