# Evernote Migration Plan

## TL;DR

**Recommended destination: Obsidian**  
**Migration tool: Obsidian Importer plugin (official) + `evernote2md` CLI as backup**  
**Estimated time: 1–2 hours for a dozen notebooks**

---

## 1. Why Leave Evernote

Evernote Personal is ~$14.99/month (~$180/year). The free tier was gutted in 2024 (50-note cap). For light users with a dozen notebooks, this is hard to justify.

---

## 2. Alternative Evaluation

| App | Cost | Storage | Mac-native | Evernote Import | Notes |
|---|---|---|---|---|---|
| **Obsidian** | Free (local) / $4/mo sync | Local files | Yes | Official plugin | Best long-term option; plain Markdown |
| **Joplin** | Free | Local + sync via Dropbox/iCloud | Yes (Electron) | Built-in ENEX import | Open source, E2E encryption |
| **Bear** | $2.99/mo | iCloud | Yes (native) | Built-in ENEX import | Best Mac UX; still a subscription |
| **Notion** | Free / $10/mo | Cloud | Yes | Built-in importer | Powerful but bloated for light use |
| **Apple Notes** | Free | iCloud | Yes (native) | ENEX import via script | Too basic; poor organization |
| **OneNote** | Free | OneDrive | Yes | Built-in importer | Fine but Microsoft ecosystem |

### Recommendation: Obsidian

**Reasons:**

1. **Free forever for local use.** No subscription required. Optional sync is $4/month (Obsidian Sync) or free via iCloud Drive — either way far cheaper than Evernote.
2. **Your notes are plain Markdown files on disk.** They live in a normal folder. You can open them in any text editor, search with `grep`, back them up with Time Machine, sync with Git, or move to any future app. You are never locked in again.
3. **Official Evernote importer.** The built-in Importer plugin handles ENEX files, preserves attachments, tags, and notebook structure, and converts everything to Markdown automatically.
4. **Best long-term durability.** Plain text Markdown files from 2026 will still open perfectly in 2040. Proprietary formats do not have this guarantee.
5. **Powerful enough for growth.** If you end up using it more, Obsidian has a huge plugin ecosystem (templates, graph view, canvas, tasks, etc.) and a strong community.

**Tradeoff:** Obsidian is not as "polished" as Bear on Mac aesthetics, and requires slightly more initial setup than a pure cloud app. For a light user who just wants their notes safe and accessible, this is the right call.

---

## 3. Migration Plan

### Phase 1: Export from Evernote (30–60 min depending on note count)

Evernote's desktop app (Mac) exports notebooks to `.enex` format — an XML archive containing all note content, attachments, tags, and metadata.

**Steps:**

1. Open the **Evernote desktop app** on your Mac (export requires the desktop app, not the web version).
2. In the left sidebar, right-click each notebook and select **Export Notebook...**.
3. In the export dialog:
   - Choose format: **ENEX**
   - Check: Tags, Created date, Updated date, Author, Source URL
   - Click **Export**
4. Save each `.enex` file with the notebook name (e.g., `Work.enex`, `Recipes.enex`). Put them all in one folder, e.g., `~/Desktop/evernote-export/`.
5. Repeat for each notebook (about a dozen, so ~10–15 minutes total).

> **Tip for notebook stacks:** If you have notebooks organized into stacks in Evernote and want to preserve that folder structure in Obsidian, rename your `.enex` files using this format before importing: `StackName@@@NotebookName.enex`. Obsidian's importer recognizes this convention and creates nested folders.

**Verify your exports:**
```bash
# Quick check — list files and their sizes
ls -lh ~/Desktop/evernote-export/

# Count how many <note> elements are in each file (= note count)
for f in ~/Desktop/evernote-export/*.enex; do
  echo "$f: $(grep -c '<note>' "$f") notes"
done
```

---

### Phase 2: Set Up Obsidian (10 min)

1. Download and install Obsidian from [obsidian.md](https://obsidian.md) — it's free.
2. On first launch, create a new vault. Choose a location that works for your sync strategy:
   - **iCloud sync (free):** `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/MyVault`
   - **Local only:** anywhere on disk, e.g., `~/Documents/Notes`
3. In Obsidian, go to **Settings → Community plugins → Browse**, search for **Importer**, install it, and enable it.

---

### Phase 3: Import ENEX Files into Obsidian (15–30 min)

**Option A — Obsidian Importer Plugin (recommended, no code required):**

1. Open the Importer plugin via the command palette (`Cmd+P` → "Open Importer").
2. Select format: **Evernote (.enex)**.
3. Click the folder icon and point it at your `~/Desktop/evernote-export/` folder.
4. Click **Import**. The plugin will process all `.enex` files and create one Markdown folder per notebook inside your vault.
5. Watch the progress counter. When done, your notes appear in Obsidian's file explorer, organized by notebook.

**Option B — `evernote2md` CLI (programmatic, more control):**

If you want more control over the output, or want to script the process, use `evernote2md` — a mature Go CLI tool (1,000+ GitHub stars, actively maintained through early 2026).

```bash
# Install via Homebrew
brew install evernote2md

# Convert a single notebook's ENEX to a folder of Markdown files
evernote2md ~/Desktop/evernote-export/Work.enex ~/Documents/Notes/Work/

# Convert all notebooks in one pass
for f in ~/Desktop/evernote-export/*.enex; do
  notebook=$(basename "$f" .enex)
  evernote2md "$f" ~/Documents/Notes/"$notebook"/
done
```

Output per note:
- A `.md` file with YAML frontmatter (tags, creation date, source URL)
- Attachments (images, PDFs) in a `resources/` subfolder with inline links preserved

Then open `~/Documents/Notes/` as your Obsidian vault.

---

### Phase 4: Post-Migration Cleanup (15 min)

1. **Spot-check a sample of notes** — open 5–10 across different notebooks and verify content, formatting, and attachments look correct.
2. **Review tags** — Evernote tags become Obsidian tags in the note frontmatter. You can manage these in Obsidian's Tags panel.
3. **Search for anything that looks off:**
   ```bash
   # Find any notes that may have import artifacts
   grep -r "en-todo" ~/Documents/Notes/  # Evernote checkboxes
   grep -r "<\!" ~/Documents/Notes/       # Leftover HTML/XML
   ```
4. **Cancel your Evernote subscription** once you've confirmed everything migrated correctly. Give yourself 1–2 weeks before cancelling to ensure nothing was missed.

---

## 4. Sync Strategy (pick one)

| Option | Cost | Mac + iPhone? | Setup effort |
|---|---|---|---|
| **iCloud** (Obsidian container) | Free | Yes | Minimal — use the path below |
| **Obsidian Sync** | $4/mo | Yes | In-app, end-to-end encrypted |
| **Git** (for technical users) | Free | Mac only | `git init` in vault + GitHub private repo |
| **Dropbox / OneDrive** | Varies | Mac only | Put vault in synced folder |

### iCloud Setup (Mac + iPhone, free)

iCloud sync works on both Mac and iPhone, but the vault must live in Obsidian's dedicated iCloud container — not just anywhere in iCloud Drive. A generic iCloud Drive folder will not be accessible from the Obsidian iOS app.

**Mac:** When creating your vault in Obsidian, use this path (it's the default Obsidian suggests):
```
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/MyVault
```

**iPhone:** Install Obsidian from the App Store → tap **Open vault from iCloud** → it automatically finds any vault in that container. Edits sync in both directions.

That's it — no paid subscription needed. iCloud handles the rest.

---

## 5. Timeline Summary

| Step | Time |
|---|---|
| Export all notebooks from Evernote | 30–60 min |
| Install and set up Obsidian | 10 min |
| Run import (Importer plugin or CLI) | 15–30 min |
| Spot-check and cleanup | 15 min |
| Cancel Evernote subscription | 5 min |
| **Total** | **~1.5–2 hours** |
