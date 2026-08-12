/**
 * Cloudflare AI Gateway routing for provider calls (Anthropic + OpenAI).
 *
 * Every request is tagged with cf-aig-metadata so gateway logs separate:
 *   - billing: "platform"  → paid by the operator's own provider keys
 *   - billing: "byok"      → paid by a user's own key (user_id identifies whose)
 *
 * The gateway is an observability layer, not a dependency: any gateway fault
 * (5xx, 404, AiGatewayError body, network error) fails OPEN by retrying the
 * direct provider URL, so a broken gateway can never break digests.
 */

export interface AiCallMeta {
  billing: "platform" | "byok";
  /** Which user's key funded the call (BYOK). */
  user_id?: string;
  /** What the call was for (topics, digest_script, embeddings, ...). */
  purpose?: string;
}

const GATEWAY_BASE =
  "https://gateway.ai.cloudflare.com/v1/78bc485245e71abb26a6cee477ab3ede/podgest";

function gatewayUrlFor(directUrl: string): string | null {
  if (directUrl.startsWith("https://api.anthropic.com/")) {
    return `${GATEWAY_BASE}/anthropic/${directUrl.slice("https://api.anthropic.com/".length)}`;
  }
  // The gateway's OpenAI provider path omits the /v1 prefix.
  if (directUrl.startsWith("https://api.openai.com/v1/")) {
    return `${GATEWAY_BASE}/openai/${directUrl.slice("https://api.openai.com/v1/".length)}`;
  }
  return null;
}

export async function aiFetch(
  directUrl: string,
  init: RequestInit,
  meta: AiCallMeta
): Promise<Response> {
  const gatewayUrl = gatewayUrlFor(directUrl);
  if (!gatewayUrl) return fetch(directUrl, init);
  try {
    const headers = new Headers(init.headers);
    headers.set("cf-aig-metadata", JSON.stringify(meta));
    const response = await fetch(gatewayUrl, { ...init, headers });
    if (response.ok) return response;
    const gatewayFault =
      response.status >= 500 ||
      response.status === 404 ||
      (await response.clone().text().catch(() => "")).includes("AiGatewayError");
    if (!gatewayFault) return response;
    console.warn(
      `[AI Gateway] ${response.status} from gateway; failing open to direct provider`
    );
  } catch (error) {
    console.warn(`[AI Gateway] request failed (${error}); failing open to direct provider`);
  }
  return fetch(directUrl, init);
}
