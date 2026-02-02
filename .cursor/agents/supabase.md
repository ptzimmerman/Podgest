# Supabase Agent Context

## Credentials (from .env)

- **SUPABASE_URL**: `https://xpviiukiavtpsnafpdmy.supabase.co`
- **SUPABASE_SERVICE_ROLE_KEY**: Used for authenticated API calls

## Executing SQL via Supabase

Use the Supabase SQL API endpoint to execute arbitrary SQL:

```bash
curl -X POST "https://xpviiukiavtpsnafpdmy.supabase.co/rest/v1/rpc/exec_sql" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT * FROM cron.job"}'
```

## Common Operations

### List cron jobs
```bash
curl -s "https://xpviiukiavtpsnafpdmy.supabase.co/rest/v1/rpc/list_cron_jobs" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

### Call any RPC function
```bash
curl -X POST "https://xpviiukiavtpsnafpdmy.supabase.co/rest/v1/rpc/FUNCTION_NAME" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"param1": "value1"}'
```

## Database Connection

For direct psql access, use the pooler connection:
```
postgresql://postgres.xpviiukiavtpsnafpdmy:[DB_PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

## Migrations

Migrations are in `supabase/migrations/`. Push with:
```bash
supabase db push
```
