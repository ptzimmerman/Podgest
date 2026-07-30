#!/usr/bin/env python3
import json
import glob
import os
from datetime import datetime

export_dir = os.path.join(os.path.dirname(__file__), "chat_gpt_export", "chat_gpt_export")
output_file = os.path.join(os.path.dirname(__file__), "chatgpt_conversations.txt")

conversations = []
for path in sorted(glob.glob(os.path.join(export_dir, "conversations-*.json"))):
    with open(path, "r") as f:
        conversations.extend(json.load(f))

conversations.sort(key=lambda c: c.get("create_time") or 0)

def walk_messages(mapping, node_id):
    """Walk the conversation tree from a node, following children in order."""
    messages = []
    node = mapping.get(node_id)
    if not node:
        return messages
    msg = node.get("message")
    if msg and msg.get("content"):
        role = msg["author"]["role"]
        content = msg["content"]
        if content.get("content_type") == "text" and content.get("parts"):
            text = "\n".join(str(p) for p in content["parts"] if isinstance(p, str) and p.strip())
            if text and role in ("user", "assistant"):
                messages.append((role, text))
    for child_id in node.get("children", []):
        messages.extend(walk_messages(mapping, child_id))
    return messages

def find_root(mapping):
    """Find the root node (one with no parent or parent not in mapping)."""
    all_ids = set(mapping.keys())
    for nid, node in mapping.items():
        parent = node.get("parent")
        if not parent or parent not in all_ids:
            return nid
    return next(iter(mapping)) if mapping else None

total_chars = 0
with open(output_file, "w") as out:
    for conv in conversations:
        title = conv.get("title") or "Untitled"
        create_time = conv.get("create_time")
        date_str = datetime.fromtimestamp(create_time).strftime("%Y-%m-%d") if create_time else "Unknown date"
        mapping = conv.get("mapping", {})
        if not mapping:
            continue

        root = find_root(mapping)
        messages = walk_messages(mapping, root)
        if not messages:
            continue

        header = f"\n{'='*80}\n{title} ({date_str})\n{'='*80}\n"
        out.write(header)
        total_chars += len(header)

        for role, text in messages:
            label = "USER" if role == "user" else "ASSISTANT"
            block = f"\n[{label}]\n{text}\n"
            out.write(block)
            total_chars += len(block)

print(f"Wrote {len(conversations)} conversations to {output_file}")
print(f"Total size: {total_chars / 1_000_000:.1f} MB ({total_chars:,} characters)")
