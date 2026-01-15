// Inngest client
export { inngest } from "./client";
export type { Events } from "./client";

// RSS utilities
export { parseRSSFeed } from "./rss";
export type { RSSFeed, RSSEpisode } from "./rss";

// Workflow functions
export { pollSubscriptions } from "./functions/poll-subscriptions";
export { pollSubscription } from "./functions/poll-subscription";
export { transcribeEpisode } from "./functions/transcribe-episode";
export {
  handleTranscriptionComplete,
  handleTranscriptionFailed,
} from "./functions/handle-transcription";

// All functions array for Inngest serve
import { pollSubscriptions } from "./functions/poll-subscriptions";
import { pollSubscription } from "./functions/poll-subscription";
import { transcribeEpisode } from "./functions/transcribe-episode";
import {
  handleTranscriptionComplete,
  handleTranscriptionFailed,
} from "./functions/handle-transcription";

export const functions = [
  pollSubscriptions,
  pollSubscription,
  transcribeEpisode,
  handleTranscriptionComplete,
  handleTranscriptionFailed,
];
