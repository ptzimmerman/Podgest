import { describe, expect, it } from "vitest";
import {
  ELIGIBLE_DIGEST_PROFILES_SQL,
  MAX_WATCHDOG_REQUEUES_PER_DAY,
  usableDigestStatus,
} from "../src/digest-recovery";

describe("digest recovery policy", () => {
  it("retries missing and failed digests but not usable ones", () => {
    expect(usableDigestStatus([])).toBeNull();
    expect(usableDigestStatus(["failed"])).toBeNull();
    expect(usableDigestStatus(["generating"])).toBe("generating");
    expect(usableDigestStatus(["failed", "completed"])).toBe("completed");
  });

  it("bounds watchdog retries", () => {
    expect(MAX_WATCHDOG_REQUEUES_PER_DAY).toBe(2);
  });

  it("requires active subscriptions and both validated API keys", () => {
    expect(ELIGIBLE_DIGEST_PROFILES_SQL).toContain(
      "subscriptions.is_active = 1"
    );
    expect(ELIGIBLE_DIGEST_PROFILES_SQL).toContain(
      "keys.anthropic_valid = 1"
    );
    expect(ELIGIBLE_DIGEST_PROFILES_SQL).toContain("keys.openai_valid = 1");
  });
});
