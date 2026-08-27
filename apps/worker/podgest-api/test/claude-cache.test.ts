import { describe, expect, it } from "vitest";
import {
  TOPICS_SYSTEM_PROMPT,
  buildClaudeRequestBody,
  cachedSystem,
  parseClaudeUsage,
  stripMarkdownJsonFence,
} from "../src/claude";

describe("Anthropic prompt-cache breakpoints", () => {
  it("marks only the static system prefix, never the user turn", () => {
    const body = buildClaudeRequestBody({
      system: cachedSystem("static instructions", "today is Thursday", "1h"),
      user: "Analyze this transcript…",
      maxTokens: 1024,
    });
    const system = body.system as Array<{
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(2);
    expect(system[0].text).toBe("static instructions");
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(system[1].text).toBe("today is Thursday");
    expect(system[1].cache_control).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "user", content: "Analyze this transcript…" },
    ]);
    expect(body).not.toHaveProperty("cache_control");
  });

  it("5-minute TTL omits the ttl field (Anthropic default)", () => {
    const [block] = cachedSystem("prefix", undefined, "5m");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("topic-extraction instructions are long enough to meet the Sonnet 5 cache floor", () => {
    // 1,024 tokens ≈ 4k+ characters. A short system prompt is silently not cached.
    expect(TOPICS_SYSTEM_PROMPT.length).toBeGreaterThan(4_000);
  });

  it("parses cache usage and strips markdown fences", () => {
    expect(
      parseClaudeUsage({
        usage: {
          input_tokens: 12_000,
          output_tokens: 400,
          cache_creation_input_tokens: 1_500,
          cache_read_input_tokens: 1_500,
        },
      })
    ).toEqual({
      input_tokens: 12_000,
      output_tokens: 400,
      cache_creation_input_tokens: 1_500,
      cache_read_input_tokens: 1_500,
    });
    expect(stripMarkdownJsonFence("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
  });
});
