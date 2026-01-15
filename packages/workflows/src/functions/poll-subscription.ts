import { inngest } from "../client";
import { createClient } from "@supabase/supabase-js";
import { parseRSSFeed } from "../rss";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Poll a single subscription for new episodes.
 * Creates episode records and triggers transcription for new ones.
 */
export const pollSubscription = inngest.createFunction(
  {
    id: "poll-subscription",
    name: "Poll Single Subscription",
    concurrency: {
      limit: 5, // Don't hammer RSS feeds
    },
    retries: 3,
  },
  { event: "podcast/subscription.poll" },
  async ({ event, step }) => {
    const { subscription_id, user_id, feed_url, podcast_title } = event.data;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Fetch and parse the RSS feed
    const feed = await step.run("fetch-rss", async () => {
      return await parseRSSFeed(feed_url);
    });

    // Update subscription metadata if changed
    await step.run("update-subscription", async () => {
      await supabase
        .from("subscriptions")
        .update({
          artwork_url: feed.artwork_url,
          last_polled_at: new Date().toISOString(),
        })
        .eq("id", subscription_id);
    });

    // Get existing episode GUIDs for this subscription
    const existingGuids = await step.run("get-existing-episodes", async () => {
      const { data } = await supabase
        .from("episodes")
        .select("guid")
        .eq("subscription_id", subscription_id);
      
      return new Set((data || []).map((e) => e.guid));
    });

    // Find new episodes (not already in DB)
    const newEpisodes = feed.episodes.filter((ep) => !existingGuids.has(ep.guid));

    // Limit to most recent 5 new episodes to avoid overwhelming on first run
    const episodesToProcess = newEpisodes.slice(0, 5);

    // Create episode records and trigger transcription
    const createdEpisodes = await step.run("create-episodes", async () => {
      const results = [];

      for (const episode of episodesToProcess) {
        const { data, error } = await supabase
          .from("episodes")
          .insert({
            subscription_id,
            guid: episode.guid,
            title: episode.title,
            description: episode.description,
            audio_url: episode.audio_url,
            duration_seconds: episode.duration_seconds,
            published_at: episode.published_at.toISOString(),
            status: "pending",
          })
          .select("id")
          .single();

        if (error) {
          console.error(`Failed to create episode: ${error.message}`);
          continue;
        }

        results.push({
          episode_id: data.id,
          audio_url: episode.audio_url,
          title: episode.title,
        });
      }

      return results;
    });

    // Trigger transcription for each new episode
    if (createdEpisodes.length > 0) {
      await step.sendEvent(
        "trigger-transcriptions",
        createdEpisodes.map((ep) => ({
          name: "podcast/episode.new" as const,
          data: {
            episode_id: ep.episode_id,
            subscription_id,
            user_id,
            audio_url: ep.audio_url,
            title: ep.title,
          },
        }))
      );
    }

    return {
      subscription: podcast_title,
      total_episodes: feed.episodes.length,
      new_episodes: createdEpisodes.length,
    };
  }
);
