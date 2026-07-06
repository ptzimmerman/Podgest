#!/usr/bin/env python3
"""
Convert dumps/transcript_embeddings.jsonl into Vectorize NDJSON files
(id + values + metadata). Vector id == transcript_chunks.id in D1.
Splits output into ~4000-vector files to stay well under upload limits.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "dumps", "transcript_embeddings.jsonl")
OUT_DIR = os.path.join(HERE, "vectorize_import")
PER_FILE = 4000

os.makedirs(OUT_DIR, exist_ok=True)

count = 0
file_idx = 0
out = open(os.path.join(OUT_DIR, f"vectors-{file_idx:03d}.ndjson"), "w")
with open(SRC) as f:
    for line in f:
        r = json.loads(line)
        vec = json.loads(r["embedding"])  # pgvector serialized as '[...]' string
        assert len(vec) == 1536, f"bad dims for {r['id']}"
        rec = {
            "id": r["id"],
            "values": vec,
            "metadata": {
                "type": "transcript",
                "episode_id": r["episode_id"],
                "user_id": r["user_id"],
                "created_at": r["created_at"][:10],
            },
        }
        out.write(json.dumps(rec) + "\n")
        count += 1
        if count % PER_FILE == 0:
            out.close()
            file_idx += 1
            out = open(os.path.join(OUT_DIR, f"vectors-{file_idx:03d}.ndjson"), "w")
out.close()
print(f"{count} vectors -> {file_idx + 1} file(s) in {OUT_DIR}")
