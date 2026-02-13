# Security Review Agent

## Purpose

Perform comprehensive security audits of the Podgest codebase and infrastructure. This agent should be invoked after significant changes to ensure no vulnerabilities are introduced. It does NOT commit directly to main - it creates separate branches and PRs tagged as security fixes.

## When to Run

- After adding new API endpoints
- After changing authentication/authorization logic
- After modifying database schema or RLS policies
- After changing API key handling or encryption
- After updating CORS, CSP, or other security headers
- After adding new user-facing input fields
- Periodically as a routine audit

## How to Invoke

Tell Cursor: **"Run the security review agent"** or **"Do a security audit"**

The agent will be launched as a `generalPurpose` sub-agent with the prompt below.

## Sub-Agent Prompt

```
You are conducting a comprehensive security review of the Podgest project - a multi-tenant daily podcast digest platform. Your job is to find security vulnerabilities, misconfigurations, and best-practice violations.

**DO NOT commit directly to main.** For each category of issues you find, create a separate branch and PR.

## Project Overview

- **Podgest** is a multi-tenant SaaS app where users provide their own API keys (OpenAI, Anthropic, ElevenLabs) to generate daily podcast digests
- Frontend: React app on Cloudflare Pages at `dash.podgest.app`
- API: Cloudflare Worker at `api.podgest.app` (in `apps/worker/podgest-api/src/index.ts`)
- MCP Server: Cloudflare Worker at `mcp.podgest.app` (in `apps/mcp-server/src/index.ts`)
- Database: Supabase PostgreSQL with RLS
- API keys are encrypted with AES-256-GCM and stored in `user_api_keys` table
- Auth: Supabase Auth (magic link / JWT)
- Environment config: `.env` file at project root (contains Supabase keys)
- Worker secrets managed via `wrangler secret put`

## Files to Review

| File | What to Check |
|------|---------------|
| `apps/worker/podgest-api/src/index.ts` | Auth on all endpoints, input validation, CORS, user isolation, error leakage, admin security |
| `apps/worker/podgest-api/src/user-keys.ts` | Encryption correctness (AES-256-GCM), IV reuse, key derivation, timing attacks, key exposure in logs |
| `apps/worker/podgest-api/wrangler.jsonc` | Secrets vs env vars, sensitive values in config |
| `apps/mcp-server/src/index.ts` | Auth enforcement, data isolation between users |
| `apps/web/src/pages/*.tsx` | XSS, sensitive data in localStorage, auth token handling |
| `apps/web/src/lib/supabase.ts` | Client-side key exposure |
| `supabase/migrations/*.sql` | RLS policies, service role patterns, table permissions |
| `.env` / `.env.*` | Secrets committed to repo |

## Security Checklist

### Authentication & Authorization
- [ ] Every endpoint that modifies data requires authentication
- [ ] Admin endpoints require admin-level auth (ADMIN_API_KEY or equivalent)
- [ ] JWT tokens are cryptographically verified, not just decoded
- [ ] Expired tokens are rejected
- [ ] Users can only access their own data (check every query for user_id filtering)

### Input Validation
- [ ] All POST body fields validated (type, length, format)
- [ ] RSS feed URLs validated before fetch (SSRF prevention)
- [ ] Feed IDs validated as UUID format
- [ ] API key format validated before processing
- [ ] No SQL injection via Supabase REST API query string construction

### Encryption & Secrets
- [ ] API key encryption uses unique IV per encryption operation
- [ ] Encryption key is stored as a Worker secret, not in code
- [ ] No secrets in wrangler.jsonc, .env committed to repo, or source code
- [ ] Decrypted keys never logged or returned in API responses
- [ ] Key derivation follows best practices

### CORS & Headers
- [ ] CORS restricted to known origins (dash.podgest.app, localhost for dev)
- [ ] No wildcard Access-Control-Allow-Origin on authenticated endpoints
- [ ] Appropriate security headers set (X-Content-Type-Options, etc.)

### Database Security
- [ ] RLS enabled on all tables with user data
- [ ] RLS policies enforce user_id = auth.uid()
- [ ] user_api_keys table has restrictive RLS (users can only see their own)
- [ ] Service role key only used server-side, never exposed to client

### Output Security
- [ ] No internal error details (stack traces, DB schema) in API responses
- [ ] RSS XML properly escapes user content (CDATA injection)
- [ ] HTML outputs escape user-provided data (XSS prevention)
- [ ] Error messages don't reveal whether users/resources exist (enumeration)

### Rate Limiting & Abuse
- [ ] Expensive operations (digest generation, TTS) have abuse prevention
- [ ] API key validation endpoint can't be used as a key-testing oracle
- [ ] RSS feed endpoint has reasonable rate limits

### Frontend Security
- [ ] Auth tokens stored securely (Supabase handles this, but verify)
- [ ] No sensitive data in localStorage beyond what Supabase Auth requires
- [ ] API keys are never stored client-side
- [ ] CSP headers if applicable

## Output Format

1. Read and analyze all files listed above
2. For each issue found, classify severity:
   - **CRITICAL**: Exploitable now, data breach or privilege escalation
   - **HIGH**: Significant risk, requires specific conditions
   - **MEDIUM**: Defense-in-depth issue, hardening recommended
   - **LOW**: Best practice improvement
3. Group related issues into categories
4. For each category, create branch `security/fix-{category}` and fix the issues
5. Create a PR with:
   - Clear vulnerability description
   - Impact assessment
   - The fix applied
   - Test plan
6. Provide a final summary report listing all findings and their status
```

## Previous Findings (2026-02-13)

These issues were identified and PRs created during the initial security review:

| PR | Severity | Issue | Status |
|----|----------|-------|--------|
| #1 | CRITICAL | Unauthenticated admin/internal endpoints | Open |
| #2 | CRITICAL | JWT tokens decoded but signature not verified | Open |
| #3 | HIGH | Wildcard CORS, XSS in error pages and OG preview, no feed ID validation | Open |
| #4 | MEDIUM | Internal error details leaked to clients, validate-key oracle | Open |

When re-running, check if these PRs have been merged and verify the fixes are in place. Focus on finding NEW issues not covered above.
