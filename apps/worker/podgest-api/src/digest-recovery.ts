export const MAX_WATCHDOG_REQUEUES_PER_DAY = 2;

export const ELIGIBLE_DIGEST_PROFILES_SQL = `
  SELECT DISTINCT p.id, p.email, p.timezone
  FROM profiles p
  JOIN user_api_keys keys ON keys.user_id = p.id
  WHERE keys.anthropic_key_encrypted IS NOT NULL
    AND length(keys.anthropic_key_encrypted) > 0
    AND keys.anthropic_valid = 1
    AND keys.openai_key_encrypted IS NOT NULL
    AND length(keys.openai_key_encrypted) > 0
    AND keys.openai_valid = 1
    AND EXISTS (
      SELECT 1 FROM subscriptions subscriptions
      WHERE subscriptions.user_id = p.id AND subscriptions.is_active = 1
    )`;

export function usableDigestStatus(
  statuses: string[]
): "generating" | "completed" | null {
  if (statuses.includes("completed")) return "completed";
  if (statuses.includes("generating")) return "generating";
  return null;
}
