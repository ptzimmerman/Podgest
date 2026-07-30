import { describe, expect, it } from "vitest";
import { classifyApiKeyFailure } from "../src/api-key-alerts";

describe("API-key failure alerts", () => {
  it("classifies exhausted OpenAI quota as a permanent key failure", () => {
    expect(classifyApiKeyFailure(
      "Error code: 429 - insufficient_quota: You exceeded your current quota"
    )).toEqual({
      provider: "openai",
      kind: "no_credits",
      reason: "OpenAI reported that the account has no available API credits",
    });
  });

  it("classifies Anthropic authentication and credit failures", () => {
    expect(classifyApiKeyFailure(
      "Claude API error: authentication_error: invalid x-api-key"
    )).toEqual({
      provider: "anthropic",
      kind: "invalid_key",
      reason: "Anthropic rejected the API key",
    });
    const anthropicCredits = classifyApiKeyFailure(
      "Claude API error: credit balance is too low"
    );
    expect(anthropicCredits?.provider).toBe("anthropic");
    expect(anthropicCredits?.kind).toBe("no_credits");
  });

  it("does not email for transient or non-key failures", () => {
    expect(classifyApiKeyFailure("OpenAI rate limit exceeded")).toBeNull();
    expect(classifyApiKeyFailure("403 downloading source podcast clip")).toBeNull();
    expect(classifyApiKeyFailure("network timeout")).toBeNull();
  });
});
