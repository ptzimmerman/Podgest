-- ============================================
-- STORAGE BUCKETS
-- ============================================

-- Create storage buckets
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES 
  ('transcripts', 'transcripts', false, 52428800),  -- 50MB, private
  ('digests', 'digests', true, 104857600)           -- 100MB, public for RSS
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- STORAGE POLICIES
-- ============================================

-- Transcripts: only service role can access (backend only)
CREATE POLICY "Service role can manage transcripts"
ON storage.objects FOR ALL
TO service_role
USING (bucket_id = 'transcripts')
WITH CHECK (bucket_id = 'transcripts');

-- Digests: public read for RSS
CREATE POLICY "Public can read digests"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'digests');

-- Digests: service role can write
CREATE POLICY "Service role can write digests"
ON storage.objects FOR INSERT
TO service_role
WITH CHECK (bucket_id = 'digests');

CREATE POLICY "Service role can update digests"
ON storage.objects FOR UPDATE
TO service_role
USING (bucket_id = 'digests')
WITH CHECK (bucket_id = 'digests');

CREATE POLICY "Service role can delete digests"
ON storage.objects FOR DELETE
TO service_role
USING (bucket_id = 'digests');
