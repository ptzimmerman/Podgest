import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "@podgest/workflows";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "$env/static/private";

interface ModalWebhookPayload {
  status: "completed" | "failed";
  job_id: string; // JSON string: { episode_id, transcription_id }
  text?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  language?: string;
  duration?: number;
  error?: string;
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const payload: ModalWebhookPayload = await request.json();
    
    // Parse job_id to get episode info
    let jobData: { episode_id: string; transcription_id: string };
    try {
      jobData = JSON.parse(payload.job_id);
    } catch {
      return json({ error: "Invalid job_id format" }, { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (payload.status === "completed" && payload.text) {
      // Upload transcript to storage
      const transcriptPath = `${jobData.episode_id}/transcript.json`;
      
      const { error: uploadError } = await supabase.storage
        .from("transcripts")
        .upload(transcriptPath, JSON.stringify({
          text: payload.text,
          segments: payload.segments,
          language: payload.language,
          duration: payload.duration,
        }), {
          contentType: "application/json",
          upsert: true,
        });

      if (uploadError) {
        console.error("Failed to upload transcript:", uploadError);
      }

      // Get signed URL for transcript
      const { data: urlData } = await supabase.storage
        .from("transcripts")
        .createSignedUrl(transcriptPath, 60 * 60 * 24 * 365); // 1 year

      // Send completion event to Inngest
      await inngest.send({
        name: "podcast/transcription.complete",
        data: {
          episode_id: jobData.episode_id,
          transcript_text: payload.text,
          transcript_url: urlData?.signedUrl || "",
          duration_seconds: payload.duration || 0,
          language: payload.language || "unknown",
        },
      });

      return json({ success: true, status: "completed" });
    } else {
      // Send failure event to Inngest
      await inngest.send({
        name: "podcast/transcription.failed",
        data: {
          episode_id: jobData.episode_id,
          error: payload.error || "Unknown error",
        },
      });

      return json({ success: true, status: "failed" });
    }
  } catch (error) {
    console.error("Webhook error:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
