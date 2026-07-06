/**
 * Vector Search Utilities
 *
 * Semantic search across podcast transcripts using Cloudflare Vectorize.
 * Vectors live in the "podgest-vectors" index (1536 dims, cosine); chunk text
 * and metadata live in D1 (transcript_chunks, vector id == transcript_chunks.id).
 */

import { generateEmbedding } from './embeddings';
import { decryptApiKey } from './encryption';
import { all, one, placeholders } from './db';

/**
 * Search result from transcript search
 */
export interface TranscriptSearchResult {
  id: string;
  episode_id: string;
  episode_title: string;
  podcast_title: string;
  chunk_text: string;
  chunk_index: number;
  similarity: number;
}

/**
 * Options for transcript search
 */
export interface SearchOptions {
  limit?: number;
  filterEpisodeIds?: string[];
}

/**
 * Fetch and decrypt user's OpenAI API key from D1 (user_api_keys).
 *
 * @param db - D1 database binding
 * @param userId - User ID to fetch key for
 * @param encryptionKey - 32-byte hex encryption key for decryption
 * @returns Decrypted OpenAI API key or null if not set
 */
export async function getUserOpenAIKey(
  db: D1Database,
  userId: string,
  encryptionKey: string
): Promise<string | null> {
  if (!encryptionKey) {
    console.error('[vectorsearch] USER_ENCRYPTION_KEY not configured');
    return null;
  }

  try {
    const row = await one<{ openai_key_encrypted: string | null }>(
      db,
      'SELECT openai_key_encrypted FROM user_api_keys WHERE user_id = ?',
      userId
    );

    if (!row || !row.openai_key_encrypted) {
      return null;
    }

    // Decrypt the key
    return await decryptApiKey(row.openai_key_encrypted, encryptionKey);
  } catch (error) {
    console.error('[vectorsearch] Error fetching/decrypting OpenAI key:', error);
    return null;
  }
}

/**
 * Search transcripts using Vectorize semantic search, hydrating chunk text
 * and episode/podcast titles from D1.
 *
 * @param query - Natural language search query
 * @param userId - User ID for filtering results
 * @param openaiKey - OpenAI API key for generating query embedding
 * @param vectorize - Vectorize index binding
 * @param db - D1 database binding
 * @param options - Search options (limit, filterEpisodeIds)
 * @returns Array of transcript search results ordered by similarity
 */
export async function searchTranscripts(
  query: string,
  userId: string,
  openaiKey: string,
  vectorize: VectorizeIndex,
  db: D1Database,
  options: SearchOptions = {}
): Promise<TranscriptSearchResult[]> {
  const { limit = 10, filterEpisodeIds } = options;

  if (!query || query.trim().length === 0) {
    return [];
  }

  if (!openaiKey) {
    throw new Error('OpenAI API key is required for search');
  }

  try {
    // Generate embedding for the query
    console.log(`[vectorsearch] Generating embedding for query: "${query.substring(0, 50)}..."`);
    const queryEmbedding = await generateEmbedding(query, openaiKey);

    // Query Vectorize (topK max is 20 when returning metadata)
    const filter: Record<string, unknown> = {
      type: 'transcript',
      user_id: userId,
    };
    if (filterEpisodeIds && filterEpisodeIds.length > 0) {
      filter.episode_id = { $in: filterEpisodeIds };
    }

    const matches = await vectorize.query(queryEmbedding, {
      topK: Math.min(limit, 20),
      returnMetadata: 'all',
      filter: filter as VectorizeVectorMetadataFilter,
    });

    if (!matches.matches.length) {
      console.log('[vectorsearch] No matches found');
      return [];
    }

    // Hydrate chunk text + episode/podcast titles from D1 by matched vector ids
    const ids = matches.matches.map((m) => m.id);
    const rows = await all<{
      id: string;
      episode_id: string;
      chunk_text: string;
      chunk_index: number;
      episode_title: string | null;
      podcast_title: string | null;
    }>(
      db,
      `SELECT tc.id, tc.episode_id, tc.chunk_text, tc.chunk_index,
              e.title AS episode_title, s.podcast_title
       FROM transcript_chunks tc
       LEFT JOIN episodes e ON e.id = tc.episode_id
       LEFT JOIN subscriptions s ON s.feed_url = e.feed_url AND s.user_id = ?
       WHERE tc.id IN (${placeholders(ids.length)})`,
      userId,
      ...ids
    );

    const rowById = new Map(rows.map((r) => [r.id, r]));

    const results: TranscriptSearchResult[] = [];
    for (const match of matches.matches) {
      const row = rowById.get(match.id);
      if (!row) continue; // vector without a D1 chunk row; skip
      results.push({
        id: row.id,
        episode_id: row.episode_id,
        episode_title: row.episode_title || 'Unknown',
        podcast_title: row.podcast_title || 'Unknown',
        chunk_text: row.chunk_text,
        chunk_index: row.chunk_index,
        similarity: match.score,
      });
    }

    console.log(`[vectorsearch] Found ${results.length} results`);
    return results;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw known errors
      if (error.message.includes('OpenAI API key') ||
          error.message.includes('rate limit')) {
        throw error;
      }
      console.error('[vectorsearch] Search error:', error.message);
      throw new Error(`Search failed: ${error.message}`);
    }
    throw new Error('Search failed: Unknown error');
  }
}
