/**
 * Embedding Utilities for pgvector Integration
 * 
 * Uses OpenAI's text-embedding-3-small model (1536 dimensions).
 */

/**
 * OpenAI embedding response type
 */
interface OpenAIEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// Maximum characters to send to embedding API
const MAX_CHARS = 25000;

/**
 * Generate an embedding vector for the given text using OpenAI's API.
 * 
 * @param text - The text to embed
 * @param openaiKey - User's OpenAI API key
 * @returns 1536-dimensional embedding vector
 */
export async function generateEmbedding(
  text: string,
  openaiKey: string
): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot generate embedding for empty text');
  }

  if (!openaiKey) {
    throw new Error('OpenAI API key is required');
  }

  // Truncate if too long
  const truncatedText = text.slice(0, MAX_CHARS);

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: truncatedText,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      
      // Parse error for better messages
      if (response.status === 401) {
        throw new Error('Invalid OpenAI API key');
      }
      if (response.status === 429) {
        throw new Error('OpenAI rate limit exceeded. Please try again later.');
      }
      if (response.status === 400) {
        throw new Error(`OpenAI API error: ${error}`);
      }
      
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = await response.json() as OpenAIEmbeddingResponse;

    if (!data.data || data.data.length === 0) {
      throw new Error('No embedding returned from OpenAI');
    }

    return data.data[0].embedding;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw known errors
      if (error.message.includes('Invalid OpenAI API key') ||
          error.message.includes('rate limit') ||
          error.message.includes('OpenAI API error')) {
        throw error;
      }
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
    throw new Error('Failed to generate embedding: Unknown error');
  }
}
