#!/usr/bin/env python3
"""
Seed Better Auth `user` and `account` tables from the Supabase auth export,
preserving original user ids so profiles/digests/etc. FKs keep working.
Only Google identities are seeded (all 8 users have one).
"""

import json
import os
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))


def esc(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


users = {}
with open(os.path.join(HERE, "dumps", "auth_users.jsonl")) as f:
    for line in f:
        r = json.loads(line)
        users[r["id"]] = r

rows_user, rows_account = [], []
seen_users = set()
with open(os.path.join(HERE, "dumps", "auth_identities.jsonl")) as f:
    for line in f:
        ident = json.loads(line)
        if ident["provider"] != "google":
            continue
        u = users[ident["user_id"]]
        d = ident.get("identity_data", {})
        created = u.get("created_at") or "2026-01-01T00:00:00Z"
        if u["id"] not in seen_users:
            seen_users.add(u["id"])
            name = d.get("full_name") or d.get("name") or u["email"].split("@")[0]
            rows_user.append(
                f"({esc(u['id'])}, {esc(name)}, {esc(u['email'])}, 1, {esc(d.get('avatar_url'))}, {esc(created)}, {esc(created)})"
            )
        rows_account.append(
            f"({esc(str(uuid.uuid4()))}, {esc(ident['provider_id'])}, 'google', {esc(u['id'])}, {esc(ident.get('created_at') or created)}, {esc(ident.get('created_at') or created)})"
        )

out = os.path.join(HERE, "d1_import", "better_auth_seed.sql")
with open(out, "w") as f:
    f.write(
        'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES\n'
        + ",\n".join(rows_user)
        + ";\n"
    )
    f.write(
        'INSERT OR IGNORE INTO "account" (id, accountId, providerId, userId, createdAt, updatedAt) VALUES\n'
        + ",\n".join(rows_account)
        + ";\n"
    )
print(f"{len(rows_user)} users, {len(rows_account)} google accounts -> {out}")
