import { Inngest } from "inngest";

// Define event types for type safety
export type Events = {
  "podcast/poll.scheduled": {
    data: Record<string, never>;
  };
  "podcast/subscription.poll": {
    data: {
      subscription_id: string;
      user_id: string;
      feed_url: string;
      podcast_title: string;
    };
  };
  "podcast/episode.new": {
    data: {
      episode_id: string;
      subscription_id: string;
      user_id: string;
      audio_url: string;
      title: string;
    };
  };
  "podcast/transcription.complete": {
    data: {
      episode_id: string;
      transcript_text: string;
      transcript_url: string;
      duration_seconds: number;
      language: string;
    };
  };
  "podcast/transcription.failed": {
    data: {
      episode_id: string;
      error: string;
    };
  };
};

export const inngest = new Inngest({
  id: "podgest",
  schemas: new Map() as any, // Type hack for events
});
