/**
 * pgvector Search Utilities
 * 
 * Provides semantic search across podcast transcripts using pgvector embeddings
 * stored in Supabase.
 */

import { generateEmbedding } from './embeddings';
import { decryptApiKey } from './encryption';

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
 * Fetch and decrypt user's OpenAI API key from Supabase.
 * 
 * @param supabaseUrl - Supabase project URL
 * @param serviceRoleKey - Supabase service role key
 * @param userId - User ID to fetch key for
 * @param encryptionKey - 32-byte hex encryption key for decryption
 * @returns Decrypted OpenAI API key or null if not set
 */
export async function getUserOpenAIKey(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  encryptionKey: string
): Promise<string | null> {
  if (!encryptionKey) {
    console.error('[pgvector] USER_ENCRYPTION_KEY not configured');
    return null;
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/user_api_keys?user_id=eq.${userId}&select=openai_key_encrypted`,
      {
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      console.error('[pgvector] Failed to fetch user API keys:', await response.text());
      return null;
    }

    const rows = await response.json() as Array<{ openai_key_encrypted: string | null }>;

    if (!rows || rows.length === 0 || !rows[0].openai_key_encrypted) {
      return null;
    }

    // Decrypt the key
    return await decryptApiKey(rows[0].openai_key_encrypted, encryptionKey);
  } catch (error) {
    console.error('[pgvector] Error fetching/decrypting OpenAI key:', error);
    return null;
  }
}

/**
 * Search transcripts using pgvector semantic search.
 * 
 * @param query - Natural language search query
 * @param userId - User ID for filtering results
 * @param openaiKey - OpenAI API key for generating query embedding
 * @param supabaseUrl - Supabase project URL
 * @param serviceRoleKey - Supabase service role key
 * @param options - Search options (limit, filterEpisodeIds)
 * @returns Array of transcript search results
 */
export async function searchTranscripts(
  query: string,
  userId: string,
  openaiKey: string,
  supabaseUrl: string,
  serviceRoleKey: string,
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
    console.log(`[pgvector] Generating embedding for query: "${query.substring(0, 50)}..."`);
    const queryEmbedding = await generateEmbedding(query, openaiKey);

    // Call Supabase RPC function
    console.log(`[pgvector] Calling search_transcripts RPC for user ${userId}`);
    
    const rpcBody: Record<string, unknown> = {
      query_embedding: `[${queryEmbedding.join(',')}]`,
      match_user_id: userId,
      match_count: Math.min(limit, 20),
    };

    if (filterEpisodeIds && filterEpisodeIds.length > 0) {
      rpcBody.filter_episode_ids = filterEpisodeIds;
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/rpc/search_transcripts`,
      {
        method: 'POST',
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(rpcBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[pgvector] Search RPC failed:', errorText);
      throw new Error(`Search failed: ${errorText}`);
    }

    const results = await response.json() as TranscriptSearchResult[];
    console.log(`[pgvector] Found ${results.length} results`);

    return results;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw known errors
      if (error.message.includes('OpenAI API key') ||
          error.message.includes('rate limit')) {
        throw error;
      }
      console.error('[pgvector] Search error:', error.message);
      throw new Error(`Search failed: ${error.message}`);
    }
    throw new Error('Search failed: Unknown error');
  }
}

/**
 * Search all content (transcripts and newsletters) using pgvector.
 * 
 * @param query - Natural language search query
 * @param userId - User ID for filtering results
 * @param openaiKey - OpenAI API key for generating query embedding
 * @param supabaseUrl - Supabase project URL
 * @param serviceRoleKey - Supabase service role key
 * @param limit - Maximum number of results
 * @returns Array of search results
 */
export async function searchAllContent(
  query: string,
  userId: string,
  openaiKey: string,
  supabaseUrl: string,
  serviceRoleKey: string,
  limit = 10
): Promise<Array<{
  content_type: string;
  content_id: string;
  title: string;
  source: string;
  chunk_text: string;
  similarity: number;
}>> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  if (!openaiKey) {
    throw new Error('OpenAI API key is required for search');
  }

  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query, openaiKey);

    // Call Supabase RPC function
    const response = await fetch(
      `${supabaseUrl}/rest/v1/rpc/search_all_content`,
      {
        method: 'POST',
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query_embedding: `[${queryEmbedding.join(',')}]`,
          match_user_id: userId,
          match_count: Math.min(limit, 20),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[pgvector] search_all_content RPC failed:', errorText);
      throw new Error(`Search failed: ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Search failed: ${error.message}`);
    }
    throw new Error('Search failed: Unknown error');
  }
}
