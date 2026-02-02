-- Phase 8.1: User API Keys Table
-- Store encrypted API keys per user (AES-256-GCM encrypted)

CREATE TABLE public.user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
  
  -- Encrypted API keys (AES-256-GCM)
  openai_key_encrypted TEXT,
  anthropic_key_encrypted TEXT,
  elevenlabs_key_encrypted TEXT,
  
  -- Validation status
  openai_valid BOOLEAN DEFAULT false,
  anthropic_valid BOOLEAN DEFAULT false,
  elevenlabs_valid BOOLEAN DEFAULT false,
  
  -- Last validation timestamps
  openai_validated_at TIMESTAMPTZ,
  anthropic_validated_at TIMESTAMPTZ,
  elevenlabs_validated_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

-- Users can only access their own API keys
CREATE POLICY "Users manage their own API keys" ON public.user_api_keys
  FOR ALL USING (auth.uid() = user_id);

-- Service role bypass for backend operations
CREATE POLICY "Service role full access" ON public.user_api_keys
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_api_keys_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_api_keys_updated_at
  BEFORE UPDATE ON public.user_api_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_user_api_keys_updated_at();

-- Index for faster user lookups
CREATE INDEX user_api_keys_user_id_idx ON public.user_api_keys(user_id);
