import { inngest } from "../client";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Handle transcription completion from Modal webhook.
 * Stores the transcript and updates status.
 */
export const handleTranscriptionComplete = inngest.createFunction(
  {
    id: "handle-transcription-complete",
    name: "Handle Transcription Complete",
  },
  { event: "podcast/transcription.complete" },
  async ({ event, step }) => {
    const { episode_id, transcript_text, transcript_url, duration_seconds, language } = event.data;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Update transcription record
    await step.run("update-transcription", async () => {
      await supabase
        .from("transcriptions")
        .update({
          status: "completed",
          transcript_text,
          transcript_url,
          completed_at: new Date().toISOString(),
        })
        .eq("episode_id", episode_id);
    });

    // Update episode status and duration
    await step.run("update-episode", async () => {
      await supabase
        .from("episodes")
        .update({
          status: "transcribed",
          duration_seconds: duration_seconds || undefined,
        })
        .eq("id", episode_id);
    });

    // Log event
    await step.run("log-event", async () => {
      await supabase.from("event_log").insert({
        event_type: "transcription_completed",
        payload: { episode_id, language, duration_seconds },
      });
    });

    return { episode_id, status: "completed" };
  }
);

/**
 * Handle transcription failure from Modal webhook.
 */
export const handleTranscriptionFailed = inngest.createFunction(
  {
    id: "handle-transcription-failed",
    name: "Handle Transcription Failed",
  },
  { event: "podcast/transcription.failed" },
  async ({ event, step }) => {
    const { episode_id, error } = event.data;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Update transcription record
    await step.run("update-transcription", async () => {
      await supabase
        .from("transcriptions")
        .update({
          status: "failed",
          error_message: error,
        })
        .eq("episode_id", episode_id);
    });

    // Update episode status
    await step.run("update-episode", async () => {
      await supabase
        .from("episodes")
        .update({ status: "failed" })
        .eq("id", episode_id);
    });

    // Log event
    await step.run("log-event", async () => {
      await supabase.from("event_log").insert({
        event_type: "transcription_failed",
        payload: { episode_id, error },
      });
    });

    return { episode_id, status: "failed", error };
  }
);
