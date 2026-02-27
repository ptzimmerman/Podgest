-- Migration 027: Rotate admin API key in vault
-- The old key was exposed in migration 025 and must be replaced before going public.

-- To rotate the admin key:
-- 1. Generate a new key: openssl rand -hex 32
-- 2. Update the Cloudflare Worker secret: echo "<NEW_KEY>" | npx wrangler secret put ADMIN_API_KEY
-- 3. Run this migration with the new key value:
--    DELETE FROM vault.secrets WHERE name = 'admin_api_key';
--    SELECT vault.create_secret('<NEW_KEY>', 'admin_api_key', 'Admin API key for authenticating pg_cron calls to podgest-api');
