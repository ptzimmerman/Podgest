// ============================================
// Database Types
// ============================================

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  timezone: string;
  digest_time: string;
  digest_length_minutes: number;
  created_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  podcast_title: string;
  feed_url: string;
  artwork_url: string | null;
  priority: number;
  is_active: boolean;
  last_polled_at: string | null;
  created_at: string;
}

export interface Episode {
  id: string;
  feed_url: string;
  guid: string;
  title: string;
  description: string | null;
  audio_url: string;
  published_at: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface Transcription {
  id: string;
  episode_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  transcript_storage_path: string | null;
  supermemory_doc_id: string | null;
  word_count: number | null;
  language: string;
  processing_time_ms: number | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  completed_at: string | null;
}

export interface TopicExtraction {
  id: string;
  transcription_id: string;
  topics: Topic[];
  created_at: string;
}

export interface Topic {
  name: string;
  category: string;
  key_points: string[];
  quotes: string[];
  time_range?: { start: number; end: number };
}

export interface Digest {
  id: string;
  user_id: string;
  digest_date: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  topic_clusters: TopicCluster[] | null;
  script_storage_path: string | null;
  audio_storage_path: string | null;
  audio_url: string | null;
  duration_seconds: number | null;
  episodes_included: string[];
  total_source_minutes: number | null;
  processing_time_ms: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface TopicCluster {
  topic: string;
  sources: {
    podcast: string;
    episode: string;
    perspective: string;
  }[];
}

// ============================================
// Event Types (for Inngest)
// ============================================

export interface PodgestEvents {
  'episode.created': { episode_id: string };
  'transcription.completed': { transcription_id: string; episode_id: string };
  'topics.extracted': { transcription_id: string };
  'digest.requested': { user_id: string; date: string };
}

// ============================================
// API Types
// ============================================

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}
