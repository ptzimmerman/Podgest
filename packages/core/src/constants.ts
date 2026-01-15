// Digest length options (in minutes)
export const DIGEST_LENGTHS = [15, 30, 45] as const;
export type DigestLength = (typeof DIGEST_LENGTHS)[number];

// Priority scale for podcasts
export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 10;
export const PRIORITY_DEFAULT = 5;

// Topic categories
export const TOPIC_CATEGORIES = [
  'AI/ML',
  'Business',
  'Technology',
  'Science',
  'Politics',
  'Culture',
  'Markets',
  'Crypto',
  'Other',
] as const;
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

// Transcription
export const WHISPER_MODEL = 'base';
export const MAX_AUDIO_DURATION_HOURS = 4;

// Storage paths
export const STORAGE_BUCKETS = {
  transcripts: 'transcripts',
  digests: 'digests',
} as const;
