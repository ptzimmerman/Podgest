import { inngest } from "../client";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MODAL_WEBHOOK_URL = process.env.MODAL_WEBHOOK_URL!;

/**
 * Handle a new episode by triggering Modal transcription.
 * Modal will call back to our webhook when done.
 */
export const transcribeEpisode = inngest.createFunction(
  {
    id: "transcribe-episode",
    name: "Transcribe Episode",
    concurrency: {
      limit: 3, // Limit concurrent transcriptions (cost control)
    },
    retries: 2,
  },
  { event: "podcast/episode.new" },
  async ({ event, step }) => {
    const { episode_id, audio_url, title } = event.data;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Update episode status
    await step.run("mark-transcribing", async () => {
      await supabase
        .from("episodes")
        .update({ status: "transcribing" })
        .eq("id", episode_id);
    });

    // Create a transcription record
    const transcription = await step.run("create-transcription-record", async () => {
      const { data, error } = await supabase
        .from("transcriptions")
        .insert({
          episode_id,
          status: "processing",
        })
        .select("id")
        .single();

      if (error) throw error;
      return data;
    });

    // Trigger Modal transcription via HTTP
    // Modal will POST results to our webhook
    await step.run("trigger-modal", async () => {
      // Modal web endpoint URL format: https://{workspace}--{app}-{function}.modal.run
      const modalAppUrl = "https://ptzimmerman--podgest-transcribe-transcribe-web.modal.run";
      
      const response = await fetch(modalAppUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url,
          webhook_url: MODAL_WEBHOOK_URL,
          job_id: JSON.stringify({
            episode_id,
            transcription_id: transcription.id,
          }),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Modal request failed: ${response.status} ${text}`);
      }

      return { triggered: true };
    });

    return {
      episode_id,
      transcription_id: transcription.id,
      title,
      status: "transcription_triggered",
    };
  }
);
