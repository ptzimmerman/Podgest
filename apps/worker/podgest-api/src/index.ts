import { Inngest } from "inngest";
import { serve } from "inngest/cloudflare";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  INNGEST_EVENT_KEY: string;
  INNGEST_SIGNING_KEY: string;
}

// Create Inngest client
const inngest = new Inngest({ 
  id: "podgest",
  isDev: false,  // Force production mode
});

// Define functions
const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello" },
  async ({ event }) => {
    return { message: `Hello ${event.data?.name || "World"}!` };
  }
);

const pollSubscriptions = inngest.createFunction(
  { id: "poll-subscriptions" },
  { cron: "*/15 * * * *" },
  async () => {
    console.log("Polling subscriptions...");
    return { polled: 0 };
  }
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ 
        status: "ok", 
        timestamp: new Date().toISOString(),
        hasSigningKey: !!env.INNGEST_SIGNING_KEY,
        signingKeyLength: env.INNGEST_SIGNING_KEY?.length || 0,
      });
    }

    // Inngest endpoint
    if (url.pathname === "/api/inngest") {
      try {
        const handler = serve({
          client: inngest,
          functions: [helloWorld, pollSubscriptions],
          signingKey: env.INNGEST_SIGNING_KEY,
        });
        // serve() returns a fetch handler directly for Cloudflare
        return await handler(request, env, ctx);
      } catch (error) {
        console.error("Inngest error:", error);
        return json({ 
          error: "Inngest handler error", 
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }, 500);
      }
    }

    // Modal webhook endpoint
    if (url.pathname === "/api/webhooks/modal" && request.method === "POST") {
      return handleModalWebhook(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
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
      const transcriptPath = `${jobData.episode_id}/transcript.json`;
      await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/transcripts/${transcriptPath}`,
        {
          method: "POST",
          headers: { ...supabaseHeaders, "x-upsert": "true" },
          body: JSON.stringify({
            text: payload.text,
            segments: payload.segments,
            language: payload.language,
            duration: payload.duration,
          }),
        }
      );

      await fetch(
        `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({
            status: "completed",
            transcript_text: payload.text.substring(0, 10000),
            completed_at: new Date().toISOString(),
          }),
        }
      );

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

      return json({ success: true, status: "completed" });
    } else {
      await fetch(
        `${env.SUPABASE_URL}/rest/v1/transcriptions?episode_id=eq.${jobData.episode_id}`,
        {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ status: "failed", error_message: payload.error }),
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

      return json({ success: true, status: "failed" });
    }
  } catch (error) {
    console.error("Webhook error:", error);
    return json({ error: "Internal error", message: error instanceof Error ? error.message : String(error) }, 500);
  }
}
