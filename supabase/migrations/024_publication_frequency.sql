-- Add publication frequency tracking to subscriptions
-- Used to weight podcasts in digest generation (infrequent podcasts get higher priority)

ALTER TABLE public.subscriptions 
ADD COLUMN IF NOT EXISTS publication_frequency_days REAL;

COMMENT ON COLUMN public.subscriptions.publication_frequency_days IS 'Average days between episodes (e.g., 7.0 for weekly, 1.0 for daily). Lower = more frequent.';

-- Index for efficient sorting by frequency
CREATE INDEX IF NOT EXISTS idx_subscriptions_frequency ON public.subscriptions(publication_frequency_days);
