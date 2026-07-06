#!/usr/bin/env python3
"""
Convert migration/dumps/*.jsonl into SQL files for `wrangler d1 execute`.

- Booleans -> 0/1, dicts/lists -> JSON strings.
- pipeline_logs is skipped by default (130k rows of historical noise);
  pass --with-logs to include it.
- transcript_embeddings.jsonl -> transcript_chunks (embedding column dropped;
  vectors are loaded into Vectorize separately by build_vectorize_import.py).
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DUMPS = os.path.join(HERE, "dumps")
OUT = os.path.join(HERE, "d1_import")

# dump file -> (d1 table, column map/drops)
PLANS = [
    ("profiles", "profiles", None),
    ("subscriptions", "subscriptions", None),
    ("episodes", "episodes", None),
    ("transcriptions", "transcriptions", None),
    ("topic_extractions", "topic_extractions", None),
    ("digests", "digests", None),
    ("user_api_keys", "user_api_keys", None),
    ("transcript_embeddings", "transcript_chunks", {"drop": ["embedding"]}),
]

MAX_STMT_BYTES = 90_000  # D1 caps statements at ~100KB; stay under it


def sql_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False)
    return "'" + str(v).replace("'", "''") + "'"


def convert(dump_name, table, opts):
    src = os.path.join(DUMPS, f"{dump_name}.jsonl")
    drops = (opts or {}).get("drop", [])
    rows = []
    with open(src) as f:
        for line in f:
            r = json.loads(line)
            for d in drops:
                r.pop(d, None)
            rows.append(r)
    if not rows:
        print(f"  {table}: empty, skipped")
        return

    cols = sorted(rows[0].keys())
    prefix = f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES\n"
    path = os.path.join(OUT, f"{table}.sql")
    with open(path, "w") as f:
        pending: list[str] = []
        pending_bytes = len(prefix)
        for r in rows:
            tup = "(" + ", ".join(sql_literal(r.get(c)) for c in cols) + ")"
            tup_bytes = len(tup.encode())
            if pending and pending_bytes + tup_bytes > MAX_STMT_BYTES:
                f.write(prefix + ",\n".join(pending) + ";\n")
                pending, pending_bytes = [], len(prefix)
            pending.append(tup)
            pending_bytes += tup_bytes + 2
        if pending:
            f.write(prefix + ",\n".join(pending) + ";\n")
    print(f"  {table}: {len(rows)} rows -> {path} ({os.path.getsize(path)//1024} KB)")


def convert_legacy_auth():
    users = {}
    with open(os.path.join(DUMPS, "auth_users.jsonl")) as f:
        for line in f:
            r = json.loads(line)
            users[r["id"]] = {
                "id": r["id"],
                "email": r.get("email"),
                "provider": None,
                "provider_id": None,
                "raw_user_meta_data": r.get("raw_user_meta_data"),
                "created_at": r.get("created_at"),
                "last_sign_in_at": r.get("last_sign_in_at"),
            }
    with open(os.path.join(DUMPS, "auth_identities.jsonl")) as f:
        for line in f:
            r = json.loads(line)
            u = users.get(r["user_id"])
            # prefer the google identity if a user has several
            if u and (u["provider"] is None or r["provider"] == "google"):
                u["provider"] = r["provider"]
                u["provider_id"] = r["provider_id"]

    cols = ["id", "email", "provider", "provider_id", "raw_user_meta_data", "created_at", "last_sign_in_at"]
    path = os.path.join(OUT, "legacy_auth_users.sql")
    with open(path, "w") as f:
        values = ",\n".join(
            "(" + ", ".join(sql_literal(u.get(c)) for c in cols) + ")" for u in users.values()
        )
        f.write(f"INSERT OR REPLACE INTO legacy_auth_users ({', '.join(cols)}) VALUES\n{values};\n")
    print(f"  legacy_auth_users: {len(users)} rows -> {path}")


def main():
    os.makedirs(OUT, exist_ok=True)
    for dump_name, table, opts in PLANS:
        convert(dump_name, table, opts)
    convert_legacy_auth()
    if "--with-logs" in sys.argv:
        convert("pipeline_logs", "pipeline_logs", None)


if __name__ == "__main__":
    main()
