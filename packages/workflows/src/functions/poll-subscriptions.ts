import { inngest } from "../client";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Scheduled function that runs every 15 minutes to check for new episodes.
 * Fans out to individual subscription polling jobs.
 */
export const pollSubscriptions = inngest.createFunction(
  {
    id: "poll-subscriptions",
    name: "Poll All Subscriptions",
  },
  { cron: "*/15 * * * *" }, // Every 15 minutes
  async ({ step }) => {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Get all active subscriptions
    const subscriptions = await step.run("fetch-subscriptions", async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("id, user_id, feed_url, podcast_title")
        .eq("is_active", true);

      if (error) throw error;
      return data || [];
    });

    // Fan out to individual polling jobs
    if (subscriptions.length > 0) {
      await step.sendEvent(
        "fan-out-polling",
        subscriptions.map((sub) => ({
          name: "podcast/subscription.poll" as const,
          data: {
            subscription_id: sub.id,
            user_id: sub.user_id,
            feed_url: sub.feed_url,
            podcast_title: sub.podcast_title,
          },
        }))
      );
    }

    return { polled: subscriptions.length };
  }
);
