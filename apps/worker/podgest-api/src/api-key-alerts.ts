import { one, run } from "./db";

export type ApiKeyProvider = "openai" | "anthropic";
export type ApiKeyFailureKind = "no_credits" | "invalid_key";

export interface ApiKeyFailure {
  provider: ApiKeyProvider;
  kind: ApiKeyFailureKind;
  reason: string;
}

interface AlertEnv {
  DB: D1Database;
  RESEND_API_KEY: string;
}

const FROM_ADDRESS = "Podgest Alerts <alerts@investing.lostnomadbrewing.com>";

export function classifyApiKeyFailure(
  error: string,
  providerHint?: ApiKeyProvider
): ApiKeyFailure | null {
  const normalized = error.toLowerCase();
  const permanentFailure =
    normalized.includes("insufficient_quota") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("credit balance") ||
    normalized.includes("billing") ||
    normalized.includes("invalid api key") ||
    normalized.includes("incorrect api key") ||
    normalized.includes("authentication_error") ||
    normalized.includes("invalid x-api-key");

  if (!permanentFailure) return null;

  const provider = providerHint ??
    (normalized.includes("anthropic") || normalized.includes("claude")
      ? "anthropic"
      : "openai");

  const noCredits =
    normalized.includes("insufficient_quota") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("credit balance") ||
    normalized.includes("billing");
  const kind: ApiKeyFailureKind = noCredits ? "no_credits" : "invalid_key";
  const reason = noCredits
    ? `${provider === "openai" ? "OpenAI" : "Anthropic"} reported that the account has no available API credits`
    : `${provider === "openai" ? "OpenAI" : "Anthropic"} rejected the API key`;

  return { provider, kind, reason };
}

/** Provider-specific remediation details shown in failure emails. */
const PROVIDER_DETAILS: Record<ApiKeyProvider, {
  name: string;
  usedFor: string;
  billingUrl: string;
  keysUrl: string;
}> = {
  openai: {
    name: "OpenAI",
    usedFor:
      "turning your digest script into audio (text-to-speech) and powering podcast search",
    billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    name: "Anthropic",
    usedFor: "writing your daily digest script and extracting topics",
    billingUrl: "https://console.anthropic.com/settings/billing",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
};

const SETTINGS_URL = "https://dash.podgest.app/settings";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

async function firstKnownFailureAt(
  env: AlertEnv,
  userId: string,
  provider: ApiKeyProvider,
  fallback: string
): Promise<string> {
  const lastSuccess = await one<{ recovered_at: string | null }>(
    env.DB,
    `SELECT MAX(COALESCE(completed_at, created_at)) AS recovered_at
     FROM digests WHERE user_id = ? AND status = 'completed'`,
    userId
  );
  const failures = await env.DB.prepare(
    `SELECT created_at, error_message FROM digests
     WHERE user_id = ? AND status = 'failed' AND error_message IS NOT NULL
       AND (? IS NULL OR created_at > ?)
     ORDER BY created_at ASC`
  ).bind(
    userId,
    lastSuccess?.recovered_at ?? null,
    lastSuccess?.recovered_at ?? null
  ).all<{ created_at: string; error_message: string }>();

  for (const failure of failures.results ?? []) {
    if (classifyApiKeyFailure(failure.error_message)?.provider === provider) {
      return failure.created_at;
    }
  }
  return fallback;
}

export async function notifyApiKeyFailureOnce(
  env: AlertEnv,
  input: {
    userId: string;
    provider: ApiKeyProvider;
    kind?: ApiKeyFailureKind;
    reason: string;
    failedAt?: string;
  }
): Promise<"sent" | "already_notified" | "not_configured"> {
  const profile = await one<{
    email: string;
    display_name: string | null;
    key_validated_at: string | null;
  }>(
    env.DB,
    `SELECT profiles.email, profiles.display_name,
            CASE WHEN ? = 'openai'
              THEN keys.openai_validated_at
              ELSE keys.anthropic_validated_at
            END AS key_validated_at
     FROM profiles
     JOIN user_api_keys keys ON keys.user_id = profiles.id
     WHERE profiles.id = ?`,
    input.provider,
    input.userId
  );
  if (!profile?.key_validated_at) return "not_configured";

  const failedAt = await firstKnownFailureAt(
    env,
    input.userId,
    input.provider,
    input.failedAt ?? new Date().toISOString()
  );
  const notificationId = crypto.randomUUID();
  const inserted = await run(
    env.DB,
    `INSERT OR IGNORE INTO api_key_failure_notifications (
       id, user_id, provider, key_validated_at, first_failed_at, reason,
       email_status
     ) VALUES (?, ?, ?, ?, ?, ?, 'sending')`,
    notificationId,
    input.userId,
    input.provider,
    profile.key_validated_at,
    failedAt,
    input.reason
  );

  let claimedId = notificationId;
  if ((inserted.meta.changes ?? 0) === 0) {
    const existing = await one<{ id: string }>(
      env.DB,
      `SELECT id FROM api_key_failure_notifications
       WHERE user_id = ? AND provider = ? AND key_validated_at = ?
         AND first_failed_at = ?
         AND email_status = 'failed'`,
      input.userId,
      input.provider,
      profile.key_validated_at,
      failedAt
    );
    if (!existing) return "already_notified";

    const reclaimed = await run(
      env.DB,
      `UPDATE api_key_failure_notifications
       SET email_status = 'sending', email_error = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND email_status = 'failed'`,
      existing.id
    );
    if ((reclaimed.meta.changes ?? 0) === 0) return "already_notified";
    claimedId = existing.id;
  }

  const details = PROVIDER_DETAILS[input.provider];
  const kind: ApiKeyFailureKind =
    input.kind ?? (input.reason.toLowerCase().includes("credit") ? "no_credits" : "invalid_key");
  const firstName = profile.display_name?.trim().split(/\s+/)[0] || "there";
  const firstFailureDisplay = new Date(failedAt).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  });
  const problem =
    kind === "no_credits"
      ? `your ${details.name} account is out of API credits`
      : `${details.name} rejected your API key`;
  const fixInstruction =
    kind === "no_credits"
      ? `Add credits to your ${details.name} account (this is separate from any other AI provider you use — only ${details.name} needs a top-up). A few dollars is typically enough for months of daily digests.`
      : `Create a new ${details.name} API key and paste it into Podgest Settings.`;
  const fixUrl = kind === "no_credits" ? details.billingUrl : details.keysUrl;
  const fixLabel =
    kind === "no_credits"
      ? `Add ${details.name} credits`
      : `Get a new ${details.name} key`;
  const subject =
    kind === "no_credits"
      ? `Action needed: your ${details.name} account is out of credits, so Podgest digests are paused`
      : `Action needed: your ${details.name} API key stopped working, so Podgest digests are paused`;
  const text = [
    `Hi ${firstName},`,
    "",
    `Your daily Podgest digest has stopped because ${problem}.`,
    `Podgest uses your ${details.name} key for ${details.usedFor}, so digests cannot complete without it.`,
    "",
    `What happened: ${input.reason}`,
    `Failing since: ${firstFailureDisplay}`,
    "",
    `How to fix it: ${fixInstruction}`,
    `${fixLabel}: ${fixUrl}`,
    "",
    `After that, you can verify your key status in Podgest Settings: ${SETTINGS_URL}`,
    "Digests resume automatically on the next morning run once the key works again — no other action needed.",
    "",
    "We will not send another email for this key.",
  ].join("\n");
  const html = `
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Your daily Podgest digest has stopped because <strong>${escapeHtml(problem)}</strong>.
      Podgest uses your ${details.name} key for ${escapeHtml(details.usedFor)},
      so digests cannot complete without it.</p>
    <p><strong>What happened:</strong> ${escapeHtml(input.reason)}<br>
      <strong>Failing since:</strong> ${escapeHtml(firstFailureDisplay)}</p>
    <p><strong>How to fix it:</strong> ${escapeHtml(fixInstruction)}</p>
    <p style="margin:24px 0;">
      <a href="${fixUrl}"
         style="background:#4f46e5;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">
        ${escapeHtml(fixLabel)}
      </a>
    </p>
    <p>After that, you can verify your key status in
      <a href="${SETTINGS_URL}">Podgest Settings</a>.
      Digests resume automatically on the next morning run once the key works again
      — no other action needed.</p>
    <p style="color:#6b7280;font-size:13px;">We will not send another email for this key.</p>`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [profile.email],
        subject,
        text,
        html,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    await run(
      env.DB,
      `UPDATE api_key_failure_notifications
       SET email_status = 'sent', email_sent_at = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      new Date().toISOString(),
      claimedId
    );
    return "sent";
  } catch (error) {
    await run(
      env.DB,
      `UPDATE api_key_failure_notifications
       SET email_status = 'failed', email_error = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      claimedId
    );
    throw error;
  }
}
