# Verification Agent Context

## Purpose

Verify system functionality, API endpoints, data integrity, and end-to-end flows in the Podgest platform.

## API Endpoints

### Podgest API Worker
- **Base URL**: `https://api.podgest.app`

Key endpoints:
- `GET /health` - Health check
- `GET /feed/{userId}.xml` - User's RSS feed
- `POST /api/user-keys` - Get user key status
- `POST /api/save-key` - Save API key
- `POST /api/validate-key` - Validate API key
- `POST /api/generate-welcome` - Generate welcome episode
- `POST /api/poll` - Poll for new episodes
- `POST /api/generate-digest` - Trigger digest generation

### MCP Server
- **Base URL**: `https://mcp.podgest.app`

## Database Verification

Use Supabase REST API to verify data:

```bash
# Check user profile
curl -s "$SUPABASE_URL/rest/v1/profiles?id=eq.USER_ID" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# Check user subscriptions
curl -s "$SUPABASE_URL/rest/v1/subscriptions?user_id=eq.USER_ID" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# Check user digests
curl -s "$SUPABASE_URL/rest/v1/digests?user_id=eq.USER_ID&order=digest_date.desc&limit=5" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# Check API keys configured
curl -s "$SUPABASE_URL/rest/v1/user_api_keys?user_id=eq.USER_ID&select=openai_key_encrypted,anthropic_key_encrypted,elevenlabs_key_encrypted" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# Check embeddings count
curl -s "$SUPABASE_URL/rest/v1/transcript_embeddings?user_id=eq.USER_ID&select=count" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: count=exact"
```

## Test Users

| User | Email | User ID |
|------|-------|---------|
| Pete (primary) | peter.t.zimmerman@gmail.com | Look up in profiles table |
| Pete (BYOK test) | pete@fianu.io | Look up in profiles table |

## Verification Checklist

### API Health
- [ ] Health endpoint returns 200
- [ ] RSS feed returns valid XML
- [ ] API keys can be saved and validated

### Data Integrity
- [ ] User has profile record
- [ ] User has API keys configured
- [ ] Subscriptions are active
- [ ] Embeddings exist for subscribed content

### End-to-End Flow
- [ ] User can log in via Google OAuth
- [ ] Settings page loads with user data
- [ ] API keys show correct status
- [ ] RSS feed URL works in podcast app
- [ ] Dark mode toggle persists

## Environment Variables

Load from `.env`:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `API_ENCRYPTION_KEY`

## Reporting

When verifying:
1. State what you're checking
2. Show the command/request made
3. Report the response/result
4. Note PASS/FAIL status
5. If FAIL, suggest remediation
