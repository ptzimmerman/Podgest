/**
 * Anthropic Messages helper with explicit prompt-cache breakpoints.
 *
 * Cache the STATIC system prefix only — never the per-episode transcript or
 * per-day story list. Automatic/top-level cache_control would put the
 * breakpoint on that unique suffix, so every call would pay a cache write
 * and never hit (Anthropic: "breakpoint on content that changes").
 *
 * Sonnet 5 requires ≥1,024 cached tokens. Topic extraction's instructions
 * alone are shorter than that; TOPICS_SYSTEM_PROMPT includes a worked
 * example so the prefix actually caches. 1h TTL covers a user's overnight
 * transcription queue; 5m is enough for tight sequential loops (special
 * episode chunks).
 */

import { aiFetch, type AiCallMeta } from "./ai-gateway";

export const CLAUDE_SONNET = "claude-sonnet-5";

export type CacheTtl = "5m" | "1h";

export interface ClaudeSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Instructions + one worked example — long enough to meet Sonnet 5's 1,024-token cache floor. */
export const TOPICS_SYSTEM_PROMPT = `You are an expert at analyzing podcast transcripts. Extract structured information from the transcript provided.

Return a JSON object with exactly this structure:
{
  "topics": ["topic1", "topic2", ...],
  "themes": ["theme1", "theme2", ...],
  "summary": "A 2-3 sentence summary of the episode",
  "key_points": ["point1", "point2", ...],
  "sentiment": "positive" | "negative" | "neutral" | "mixed"
}

Rules:
- topics: 5-10 specific subjects actually discussed (e.g. "Federal Reserve interest rate policy", not "economics").
- themes: 3-5 broader arcs that connect those topics.
- key_points: 3-7 concrete takeaways a listener would remember, with names, numbers, or claims when the transcript has them.
- sentiment: overall tone of the conversation, not your opinion of the subject.
- Do not invent guests, numbers, or events that are not in the transcript.
- If the transcript is truncated, extract from what is present; do not guess the missing ending.

Worked example — transcript excerpt:
"Host: Welcome back. Today we are joined by Maya Chen, formerly of the New York Fed, on why the last CPI print does not mean the hiking cycle is over. Maya: Shelter is still sticky. The three-month annualized core is 3.4 percent. Markets priced two cuts; I think they get zero before September. Host: And in the second half we look at OpenAI's enterprise deals — Microsoft is bundling Copilot, and Adobe is training on customer PDFs. Maya: That is a data-moat story, not a model-quality story."

Correct JSON for that excerpt:
{
  "topics": [
    "US CPI and sticky shelter inflation",
    "Federal Reserve hiking cycle and rate-cut odds",
    "Core inflation three-month annualized at 3.4 percent",
    "OpenAI enterprise distribution via Microsoft Copilot",
    "Adobe training models on customer PDFs",
    "Data moats versus model quality in AI products"
  ],
  "themes": [
    "Monetary policy and market-implied cuts",
    "Enterprise AI distribution and proprietary data"
  ],
  "summary": "Maya Chen argues sticky shelter inflation means the Fed is unlikely to cut before September, contrary to market pricing of two cuts. The back half covers enterprise AI: Microsoft bundling Copilot and Adobe training on customer documents as a data-moat, not a model-quality, story.",
  "key_points": [
    "Three-month annualized core inflation at 3.4 percent with sticky shelter",
    "Chen expects zero cuts before September versus two priced by markets",
    "Microsoft is bundling Copilot into enterprise deals",
    "Adobe is training on customer PDFs; framed as a data moat"
  ],
  "sentiment": "neutral"
}

Second example — interview that turns argumentative:
"Guest: I think the merger should be blocked. Host: The companies say overlapping stores are under 4 percent nationally. Guest: National is the wrong market. In Denver they are 40 percent. Host, laughing: Fair, the local picture is uglier."
Correct sentiment is "mixed" (substantive disagreement, not hostility). Topics must include the local-vs-national market definition, not just "a merger".

What not to do:
- Collapse several distinct tickers or agencies into one vague topic.
- Use the podcast's marketing tagline as a topic if it was not discussed.
- Write a summary that editorializes ("this was a brilliant takedown").
- Pad topics to hit 5 items with generic leftovers ("current events", "the economy").
- Quote the host's jokes as key_points unless they contain a factual claim.
- Treat ad reads, subscribe-and-rate CTAs, or housekeeping as topics.
- Infer a guest's employer, title, or past role unless the transcript states it.
- Convert a hypothetical ("if they cut in July") into a reported decision.

Keep the summary to two or three sentences that a listener could text to a friend: who said what, the load-bearing number or claim, and the second-half turn if there was one. key_points should be independently readable without the summary.

IMPORTANT: Return ONLY the raw JSON object. Do NOT wrap it in markdown code fences. Do NOT include any text before or after the JSON.`;

export function cachedSystem(
  staticText: string,
  dynamicText?: string,
  ttl: CacheTtl = "1h"
): ClaudeSystemBlock[] {
  const cache_control: NonNullable<ClaudeSystemBlock["cache_control"]> =
    ttl === "1h"
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };
  const blocks: ClaudeSystemBlock[] = [
    { type: "text", text: staticText, cache_control },
  ];
  if (dynamicText) {
    blocks.push({ type: "text", text: dynamicText });
  }
  return blocks;
}

export function buildClaudeRequestBody(options: {
  system: string | ClaudeSystemBlock[];
  user: string;
  maxTokens: number;
  model?: string;
  cacheTtl?: CacheTtl | false;
}): Record<string, unknown> {
  const system =
    typeof options.system === "string"
      ? options.cacheTtl === false
        ? options.system
        : cachedSystem(options.system, undefined, options.cacheTtl ?? "1h")
      : options.system;
  return {
    model: options.model ?? CLAUDE_SONNET,
    max_tokens: options.maxTokens,
    system,
    messages: [{ role: "user", content: options.user }],
  };
}

export function parseClaudeUsage(data: {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}): ClaudeUsage {
  const usage = data.usage ?? {};
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

export function logClaudeCache(purpose: string, usage: ClaudeUsage): void {
  console.log(
    `[Claude cache] purpose=${purpose} input=${usage.input_tokens} ` +
      `write=${usage.cache_creation_input_tokens} read=${usage.cache_read_input_tokens}`
  );
}

export function stripMarkdownJsonFence(text: string): string {
  let jsonText = text.trim();
  if (jsonText.startsWith("```json")) jsonText = jsonText.slice(7);
  else if (jsonText.startsWith("```")) jsonText = jsonText.slice(3);
  if (jsonText.endsWith("```")) jsonText = jsonText.slice(0, -3);
  return jsonText.trim();
}

export async function claudeMessages(options: {
  apiKey: string;
  system: string | ClaudeSystemBlock[];
  user: string;
  maxTokens: number;
  model?: string;
  cacheTtl?: CacheTtl | false;
  meta: AiCallMeta;
}): Promise<{ text: string; usage: ClaudeUsage }> {
  const body = buildClaudeRequestBody(options);
  const response = await aiFetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    },
    options.meta
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${err}`);
  }
  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: ClaudeUsage;
  };
  const text = data.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("No text content in Claude response");
  }
  const usage = parseClaudeUsage(data);
  logClaudeCache(options.meta.purpose ?? "unknown", usage);
  return { text, usage };
}
