// Simple Cloudflare Worker for Podgest API
// Handles Inngest webhook and Modal callback

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INNGEST_EVENT_KEY: string;
  INNGEST_SIGNING_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Inngest endpoint - minimal implementation
    if (url.pathname === "/api/inngest") {
      if (request.method === "GET") {
        // Inngest introspection
        return json({
          framework: "cloudflare-workers",
          appName: "podgest",
          functions: [
            { id: "poll-subscriptions", name: "Poll All Subscriptions", triggers: [{ cron: "*/15 * * * *" }] },
          ],
          url: `${url.origin}/api/inngest`,
        });
      }
      if (request.method === "POST" || request.method === "PUT") {
        // Handle Inngest events - for now just acknowledge
        return json({ ok: true });
      }
    }

    // Modal webhook endpoint
    if (url.pathname === "/api/webhooks/modal" && request.method === "POST") {
      return handleModalWebhook(request, env);
    }

    // 404
    return json({ error: "Not found" }, 404);
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleModalWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const payload = await request.json() as {
      status: string;
      job_id: string;
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
      language?: string;
      duration?: number;
      error?: string;
    };

    // Parse job_id
    let jobData: { episode_id: string; transcription_id: string };
    try {
      jobData = JSON.parse(payload.job_id);
    } catch {
      return json({ error: "Invalid job_id" }, 400);
    }

    const supabaseHeaders = {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    };

    if (payload.status === "completed" && payload.text) {
      // Upload transcript to storage
      const transcriptPath = `${jobData.episode_id}/transcript.json`;
      const storageResponse = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/transcripts/${transcriptPath}`,
        {
          method: "POST",
          headers: {
            ...supabaseHeaders,
            "x-upsert": "true",
          },
          body: JSON.stringify({
            text: payload.text,
            segments: payload.segments,
            language: payload.language,
            duration: payload.duration,
          }),
        }
      );
      console.log("Storage upload:", storageResponse.status);

      // Update transcription record
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({
            status: "completed",
            transcript_text: payload.text.substring(0, 10000), // Truncate for DB
            completed_at: new Date().toISOString(),
          }),
        }
      );

      // Update episode status
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({
            status: "transcribed",
            duration_seconds: payload.duration,
          }),
        }
      );

      console.log("Transcription completed for episode:", jobData.episode_id);
      return json({ success: true, status: "completed" });
    } else {
      // Update as failed
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({
            status: "failed",
            error_message: payload.error,
          }),
        }
      );

      await fetch(
        `${env.SUPABASE_URL}/rest/v1/episodes?id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ status: "failed" }),
        }
      );

      console.log("Transcription failed for episode:", jobData.episode_id);
      return json({ success: true, status: "failed" });
    }
  } catch (error) {
    console.error("Webhook error:", error);
    return json({ error: "Internal error" }, 500);
  }
}
