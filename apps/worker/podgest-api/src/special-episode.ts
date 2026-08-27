/**
 * One-off / special Podgest episodes from an external document (not podcasts).
 * Reuses Alex Chen voice + TTS pipeline; never overwrites the daily digest.
 * Heavy work runs on DIGEST_QUEUE (waitUntil is too short for long PDFs).
 */

import { all, one, run } from "./db";
import { getUserApiKeys } from "./user-keys";
import { cachedSystem, claudeMessages, stripMarkdownJsonFence, type ClaudeSystemBlock } from "./claude";

export interface SpecialEpisodeEnv {
  DB: D1Database;
  TRANSCRIPTS: R2Bucket;
  DIGEST_QUEUE: Queue<SpecialQueueMessage | { user_id: string; triggered_at: string; run_id: string }>;
  ADMIN_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  API_KEY_ENCRYPTION_KEY: string;
}

export type SpecialQueueMessage =
  | {
      type: "special_episode_batch";
      r2_key: string;
      title: string;
      jobs: Array<{ user_id: string; digest_id: string }>;
      run_id: string;
      triggered_at: string;
    }
  | {
      type: "special_episode_user";
      user_id: string;
      digest_id: string;
      title: string;
      notes_r2_key: string;
      run_id: string;
      triggered_at: string;
    };


const CHUNK_CHARS = 90_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

async function callClaude(
  apiKey: string,
  system: string | ClaudeSystemBlock[],
  user: string,
  maxTokens: number
): Promise<string> {
  // Special episodes run on the platform's own Anthropic key (operator cost).
  // Sequential chunks (and users in a batch) reuse the same instructions, so
  // a 1h prefix cache is shared across that run.
  const { text } = await claudeMessages({
    apiKey,
    system,
    user,
    maxTokens,
    cacheTtl: typeof system === "string" ? "1h" : undefined,
    meta: { billing: "platform", purpose: "special_episode" },
  });
  return text;
}

function chunkText(text: string, size = CHUNK_CHARS): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const breakAt = text.lastIndexOf("\n\n", end);
      if (breakAt > start + size * 0.6) end = breakAt;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

export async function summarizeDocumentNotes(
  documentText: string,
  documentTitle: string,
  apiKey: string
): Promise<string> {
  const chunks = chunkText(documentText);
  console.log(`[Special] Summarizing ${chunks.length} chunk(s), ${documentText.length} chars`);
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[Special] Notes chunk ${i + 1}/${chunks.length}`);
    const notes = await callClaude(
      apiKey,
      `You extract dense, neutral briefing notes from long-form documents for a news podcast host.
Return structured notes (bullets / short paragraphs). Capture: thesis, key timeline/events,
institutions/actors, mechanisms/causes, evidence/stats, and conclusions.
Do NOT write a podcast script. Do NOT editorialize. Prefer facts and attributions from the text.

Use this outline every time (omit a section only if the source has nothing for it):
- Thesis / what the document is arguing
- Timeline and events (dates, sequence)
- Institutions, people, and their roles
- Mechanisms and causes (how the thing works)
- Evidence, statistics, and named sources in the text
- Conclusions, recommendations, or unresolved questions the author leaves

Example of the density we want (not the content to invent):
- Thesis: The author argues X because of Y, citing Z.
- Timeline: 2019 event A → 2022 event B → present.
- Actors: Agency Q issued the rule; Company R is the largest affected filer.
- Mechanism: The fee is assessed on volume, not headcount, so small issuers are hit harder.
- Evidence: "47% of filers" (section 3); GAO report 2024-NN.
- Conclusion: The author wants a two-year phase-in, not repeal.

Copy names, numbers, and quotes from THIS chunk. If this is part N of M, do not speculate about missing parts.`,
      `Document title: ${documentTitle}
Part ${i + 1} of ${chunks.length}:

${chunks[i]}`,
      4000
    );
    partials.push(`## Part ${i + 1}\n${notes}`);
  }
  if (partials.length === 1) return partials[0];
  console.log(`[Special] Merging ${partials.length} note parts`);
  return callClaude(
    apiKey,
    `Merge partial briefing notes into one coherent, non-redundant briefing outline for a news podcast.
Keep concrete facts, names, dates, and causal chains. Drop repetition. Still notes — not a script.`,
    `Document: ${documentTitle}\n\n${partials.join("\n\n")}`,
    6000
  );
}

export async function generateSpecialEpisodeScript(
  briefingNotes: string,
  documentTitle: string,
  maxMinutes: number,
  apiKey: string
): Promise<{ title: string; script: string; topics_covered: string[]; word_count: number }> {
  const targetWordCount = maxMinutes * 150;
  const today = new Date();
  const dayOfWeek = today.toLocaleDateString("en-US", { weekday: "long" });
  const dateStr = today.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const systemPromptStatic = `You are Alex Chen, an upbeat and energetic podcast host for "Podgest".
Your style is enthusiastic, warm, and engaging — but STRICTLY NEUTRAL. You deliver facts, not opinions.

This is a SPECIAL EPISODE summarizing ONE long document (not the usual multi-podcast digest).
CRITICAL: Summarize and explain the document's argument. Do NOT narrate or read the document aloud.
Do NOT invent facts not supported by the briefing notes.

CRITICAL RULE: You are a NEWS READER, not a commentator.
- DO NOT add opinions, reactions, or editorial commentary
- DO NOT use phrases like "What's fascinating is...", "Here's where it gets interesting..."
- JUST report what the source document says, attributed to it

STRUCTURE:
1. OPENING: use the exact opening in the schedule block below.
2. MAIN CONTENT — 3–5 thematic sections with transitions ("Alright, let's talk about… [PAUSE]").
   Cite the source naturally: "According to the document…", "The piece lays out…", "As the reporting describes…"
   End each section: "And that wraps up [SECTION]. [PAUSE]"
3. CLOSING:
   "Alright, let's zoom out for a second. [PAUSE]"
   Tie the threads together, then use the exact closing in the schedule block below.

FORMATTING:
- Include [PAUSE] markers at natural breaks
- Conversational contractions; vary sentence length
- Return ONLY JSON:
{
  "title": "Special Episode — <short title>",
  "script": "Hey there! ...",
  "topics_covered": ["...", "..."],
  "word_count": <integer>
}`;

  const systemPromptSchedule = `SCHEDULE FOR THIS EPISODE:
Today is ${dayOfWeek}, ${dateStr}.
The script MUST be approximately ${targetWordCount} words (${maxMinutes} minutes at 150 words/minute).
Hit that length with structure and detail from the notes — not filler.
Cover this document: ${documentTitle}.
Exact opening: "Hey there! It's ${dayOfWeek}, ${dateStr}, and this is a special episode of the Podgest Podcast. I'm Alex Chen. [PAUSE] Today I'm covering one deep dive: ${documentTitle}. Here's the short version of what it argues, then we'll walk through the story. Let's get into it! [PAUSE]"
Exact closing: "That's your special Podgest on ${documentTitle}. Thanks for hanging out with me — I'll catch you on the next regular digest. Until then, stay curious! [PAUSE]"`;

  const text = await callClaude(
    apiKey,
    cachedSystem(systemPromptStatic, systemPromptSchedule, "1h"),
    `Create a ${maxMinutes}-minute special-episode script summarizing this document.\n\nTitle: ${documentTitle}\n\nBriefing notes:\n${briefingNotes}`,
    16000
  );
  const cleaned = stripMarkdownJsonFence(text);
  const parsed = JSON.parse(cleaned) as {
    title: string;
    script: string;
    topics_covered: string[];
    word_count: number;
  };
  if (!parsed.script || !parsed.title) {
    throw new Error("Special episode script missing title/script");
  }
  parsed.word_count = parsed.word_count || parsed.script.split(/\s+/).length;
  return parsed;
}

async function resolveDocumentText(
  env: SpecialEpisodeEnv,
  body: {
    document_text?: string;
    r2_key?: string;
    drive_file_id?: string;
  }
): Promise<{ text: string; sourceKey: string }> {
  if (body.document_text?.trim()) {
    return { text: body.document_text.trim(), sourceKey: "inline" };
  }
  if (body.r2_key?.trim()) {
    const object = await env.TRANSCRIPTS.get(body.r2_key.trim());
    if (!object) throw new Error(`R2 object not found: ${body.r2_key}`);
    return { text: await object.text(), sourceKey: body.r2_key.trim() };
  }
  if (body.drive_file_id?.trim()) {
    throw new Error(
      "PDF Drive files must be text-extracted first; pass r2_key to pre-uploaded text"
    );
  }
  throw new Error("Provide document_text or r2_key");
}

export async function processSpecialEpisodeBatch(
  env: SpecialEpisodeEnv,
  message: Extract<SpecialQueueMessage, { type: "special_episode_batch" }>
): Promise<void> {
  const object = await env.TRANSCRIPTS.get(message.r2_key);
  if (!object) throw new Error(`Missing document at ${message.r2_key}`);
  const text = await object.text();
  const notes = await summarizeDocumentNotes(
    text,
    message.title,
    env.ANTHROPIC_API_KEY
  );
  const notesKey = `special/notes/${message.run_id}.txt`;
  await env.TRANSCRIPTS.put(notesKey, notes, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  console.log(`[Special] Notes stored at ${notesKey} (${notes.length} chars); enqueue ${message.jobs.length} user jobs`);
  for (const job of message.jobs) {
    const userMsg: SpecialQueueMessage = {
      type: "special_episode_user",
      user_id: job.user_id,
      digest_id: job.digest_id,
      title: message.title,
      notes_r2_key: notesKey,
      run_id: message.run_id,
      triggered_at: new Date().toISOString(),
    };
    await env.DIGEST_QUEUE.send(userMsg);
  }
}

export async function processSpecialEpisodeUser(
  env: SpecialEpisodeEnv,
  message: Extract<SpecialQueueMessage, { type: "special_episode_user" }>
): Promise<void> {
  const notesObj = await env.TRANSCRIPTS.get(message.notes_r2_key);
  if (!notesObj) throw new Error(`Missing notes at ${message.notes_r2_key}`);
  const briefingNotes = await notesObj.text();

  const profile = await one<{ digest_length_minutes: number | null }>(
    env.DB,
    `SELECT digest_length_minutes FROM profiles WHERE id = ?`,
    message.user_id
  );
  const maxMinutes = profile?.digest_length_minutes || 5;

  let openaiKey: string | undefined;
  try {
    const keys = await getUserApiKeys(
      env.DB,
      message.user_id,
      env.API_KEY_ENCRYPTION_KEY
    );
    openaiKey = keys.openaiKey || env.OPENAI_API_KEY;
  } catch {
    openaiKey = env.OPENAI_API_KEY;
  }
  if (!openaiKey) {
    throw new Error(`No OpenAI key for user ${message.user_id}`);
  }

  console.log(`[Special] Script for ${message.user_id.slice(0, 8)} at ${maxMinutes}m`);
  const script = await generateSpecialEpisodeScript(
    briefingNotes,
    message.title,
    maxMinutes,
    env.ANTHROPIC_API_KEY
  );

  const estimatedDuration = Math.round(script.word_count / 2.5);
  await run(
    env.DB,
    `UPDATE digests SET
       status = 'generating',
       topic_clusters = ?,
       script_text = ?,
       audio_storage_path = ?,
       audio_url = NULL,
       duration_seconds = ?,
       episodes_included = ?,
       error_message = NULL,
       completed_at = NULL
     WHERE id = ?`,
    JSON.stringify({
      title: script.title,
      topics: script.topics_covered,
      special: true,
      source: message.title,
    }),
    script.script,
    `${message.digest_id}/digest.mp3`,
    estimatedDuration,
    JSON.stringify([]),
    message.digest_id
  );

  const ttsEndpoint =
    "https://ptzimmerman--podgest-transcribe-openai-tts-web.modal.run";
  const ttsResponse = await fetch(ttsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: script.script,
      openai_api_key: openaiKey,
      voice: "echo",
      model: "tts-1-hd",
      upload_url: `https://api.podgest.app/api/webhooks/tts-audio?digest_id=${message.digest_id}`,
      digest_id: message.digest_id,
      webhook_url: "https://api.podgest.app/api/webhooks/tts",
      admin_key: env.ADMIN_API_KEY,
    }),
  });
  console.log(
    `[Special] TTS ${message.user_id.slice(0, 8)} → ${ttsResponse.status} (${script.word_count} words)`
  );
  if (!ttsResponse.ok) {
    const err = await ttsResponse.text();
    throw new Error(`TTS trigger failed: ${ttsResponse.status} ${err.slice(0, 200)}`);
  }
}

export function isSpecialQueueMessage(body: unknown): body is SpecialQueueMessage {
  if (!body || typeof body !== "object") return false;
  const type = (body as { type?: string }).type;
  return type === "special_episode_batch" || type === "special_episode_user";
}

/**
 * Admin: create special episodes for one or more users from a document.
 * Inserts NEW digest rows for today (does not replace the daily digest).
 */
export async function handleSpecialEpisode(
  request: Request,
  env: SpecialEpisodeEnv
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      user_ids?: string[];
      title?: string;
      document_text?: string;
      r2_key?: string;
      drive_file_id?: string;
      store_r2_key?: string;
    };

    const userIds = (body.user_ids || []).filter(isValidUUID);
    if (userIds.length === 0) {
      return json({ error: "user_ids required (UUIDs)" }, 400);
    }

    const documentTitle =
      body.title?.trim() ||
      "How Americas Golden Age of Aviation Safety Came to an End";

    const { text, sourceKey } = await resolveDocumentText(env, body);
    if (text.length < 500) {
      return json({ error: "Document text too short" }, 400);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Platform Anthropic key not configured" }, 500);
    }

    const finalR2Key =
      body.r2_key?.trim() ||
      body.store_r2_key?.trim() ||
      `special/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.txt`;
    if (!body.r2_key?.trim()) {
      await env.TRANSCRIPTS.put(finalR2Key, text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    }

    const digestDate = new Date().toISOString().split("T")[0];
    const jobs: Array<{ user_id: string; digest_id: string }> = [];
    const runId = crypto.randomUUID();

    for (const userId of userIds) {
      const digestId = crypto.randomUUID();
      await run(
        env.DB,
        `INSERT INTO digests (
           id, user_id, digest_date, status, topic_clusters, script_text,
           episodes_included, audio_storage_path, created_at
         ) VALUES (?, ?, ?, 'generating', ?, NULL, '[]', ?, ?)`,
        digestId,
        userId,
        digestDate,
        JSON.stringify({
          title: `Special Episode — ${documentTitle}`,
          topics: ["special"],
          special: true,
          source: documentTitle,
        }),
        `${digestId}/digest.mp3`,
        new Date().toISOString()
      );
      jobs.push({ user_id: userId, digest_id: digestId });
    }

    const batchMsg: SpecialQueueMessage = {
      type: "special_episode_batch",
      r2_key: finalR2Key,
      title: documentTitle,
      jobs,
      run_id: runId,
      triggered_at: new Date().toISOString(),
    };
    await env.DIGEST_QUEUE.send(batchMsg);

    return json({
      success: true,
      status: "queued",
      message:
        "Special episode queued on digest queue (summary → per-user scripts → TTS). Does not replace today's daily digest.",
      document_title: documentTitle,
      source_key: sourceKey,
      r2_key: finalR2Key,
      digest_date: digestDate,
      run_id: runId,
      jobs,
      document_chars: text.length,
    });
  } catch (error) {
    console.error("[Special] Error:", error);
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
}

export async function listRecentSpecialDigests(env: SpecialEpisodeEnv) {
  return all<{
    id: string;
    user_id: string;
    digest_date: string;
    status: string;
    topic_clusters: string | null;
    duration_seconds: number | null;
    audio_url: string | null;
    created_at: string;
  }>(
    env.DB,
    `SELECT id, user_id, digest_date, status, topic_clusters, duration_seconds, audio_url, created_at
     FROM digests
     WHERE topic_clusters LIKE '%"special":true%'
     ORDER BY created_at DESC
     LIMIT 20`
  );
}
