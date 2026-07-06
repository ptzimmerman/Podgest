#!/usr/bin/env python3
"""
Phase 0: full export of Supabase Postgres data via the Management API SQL
endpoint (the only channel that works while the project is 402-restricted).

Writes one JSONL file per table to migration/dumps/.

Usage:
    SBP_TOKEN=sbp_... python3 export_supabase.py
"""

import json
import os
import sys
import time
import urllib.request

PROJECT_REF = "xpviiukiavtpsnafpdmy"
API = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
TOKEN = os.environ.get("SBP_TOKEN")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dumps")

# table -> (order column, batch size). Embeddings are huge rows; keep batches small.
TABLES = {
    "profiles": ("created_at", 500),
    "subscriptions": ("created_at", 500),
    "episodes": ("created_at", 500),
    "transcriptions": ("created_at", 500),
    "topic_extractions": ("created_at", 200),
    "digests": ("created_at", 100),  # script_text can be large
    "user_api_keys": ("created_at", 500),
    "mcp_tokens": ("created_at", 500),
    "events": ("created_at", 500),
    "pipeline_logs": ("created_at", 1000),
    "transcript_embeddings": ("created_at", 50),  # 1536-dim vector per row
    "newsletter_embeddings": ("created_at", 50),
}


def run_query(sql: str, retries: int = 3):
    body = json.dumps({"query": sql}).encode()
    for attempt in range(retries):
        req = urllib.request.Request(
            API,
            data=body,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json",
                # Supabase's Cloudflare WAF 403s the default Python-urllib UA
                "User-Agent": "curl/8.7.1",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            print(f"    retry {attempt + 1} after error: {e}")
            time.sleep(2 * (attempt + 1))


def export_table(table: str, order_col: str, batch: int) -> int:
    out_path = os.path.join(OUT_DIR, f"{table}.jsonl")
    total = 0
    offset = 0
    with open(out_path, "w") as f:
        while True:
            sql = (
                f"select row_to_json(t) r from (select * from public.{table} "
                f"order by {order_col}, id limit {batch} offset {offset}) t;"
            )
            rows = run_query(sql)
            if not isinstance(rows, list):
                print(f"  ! unexpected response for {table}: {str(rows)[:200]}")
                break
            for row in rows:
                f.write(json.dumps(row["r"]) + "\n")
            total += len(rows)
            offset += batch
            if len(rows) < batch:
                break
            print(f"  {table}: {total} rows...")
    print(f"  {table}: {total} rows -> {out_path}")
    return total


def export_auth_users() -> int:
    out_path = os.path.join(OUT_DIR, "auth_users.jsonl")
    sql = (
        "select row_to_json(t) r from (select id, email, raw_user_meta_data, "
        "raw_app_meta_data, created_at, last_sign_in_at from auth.users) t;"
    )
    rows = run_query(sql)
    with open(out_path, "w") as f:
        for row in rows:
            f.write(json.dumps(row["r"]) + "\n")
    # identities carry the Google sub needed to map logins in Better Auth
    sql2 = (
        "select row_to_json(t) r from (select user_id, provider, provider_id, "
        "identity_data, created_at from auth.identities) t;"
    )
    rows2 = run_query(sql2)
    with open(os.path.join(OUT_DIR, "auth_identities.jsonl"), "w") as f:
        for row in rows2:
            f.write(json.dumps(row["r"]) + "\n")
    print(f"  auth.users: {len(rows)} rows, auth.identities: {len(rows2)} rows")
    return len(rows)


def main():
    if not TOKEN:
        sys.exit("SBP_TOKEN env var required")
    os.makedirs(OUT_DIR, exist_ok=True)

    print("Exporting public tables...")
    counts = {}
    for table, (order_col, batch) in TABLES.items():
        try:
            counts[table] = export_table(table, order_col, batch)
        except Exception as e:
            print(f"  ! FAILED {table}: {e}")
            counts[table] = -1

    print("Exporting auth schema...")
    counts["auth.users"] = export_auth_users()

    with open(os.path.join(OUT_DIR, "_manifest.json"), "w") as f:
        json.dump(
            {"exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "counts": counts},
            f,
            indent=2,
        )
    print("\nManifest:")
    print(json.dumps(counts, indent=2))
    failures = [t for t, c in counts.items() if c < 0]
    if failures:
        sys.exit(f"FAILED tables: {failures}")


if __name__ == "__main__":
    main()
