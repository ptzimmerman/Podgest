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
USING (bucket_id = 'transcripts' AND auth.role() = 'service_role')
WITH CHECK (bucket_id = 'transcripts' AND auth.role() = 'service_role');

-- Digests: public read for RSS, service role for write
CREATE POLICY "Public can read digests"
ON storage.objects FOR SELECT
USING (bucket_id = 'digests');

CREATE POLICY "Service role can manage digests"
ON storage.objects FOR INSERT
USING (bucket_id = 'digests' AND auth.role() = 'service_role')
WITH CHECK (bucket_id = 'digests' AND auth.role() = 'service_role');

CREATE POLICY "Service role can update digests"
ON storage.objects FOR UPDATE
USING (bucket_id = 'digests' AND auth.role() = 'service_role')
WITH CHECK (bucket_id = 'digests' AND auth.role() = 'service_role');

CREATE POLICY "Service role can delete digests"
ON storage.objects FOR DELETE
USING (bucket_id = 'digests' AND auth.role() = 'service_role');
