/**
 * Embedding Utilities for pgvector Integration
 * 
 * Uses OpenAI's text-embedding-3-small model (1536 dimensions).
 * Handles text chunking to stay under the 8191 token limit.
 */

// OpenAI's token limit for text-embedding-3-small
const MAX_TOKENS = 8191;

// Approximate characters per token (conservative estimate)
// OpenAI averages ~4 chars/token for English, we use 3.5 to be safe
const CHARS_PER_TOKEN = 3.5;

// Maximum characters per chunk (leaves buffer for safety)
const MAX_CHARS_PER_CHUNK = Math.floor(MAX_TOKENS * CHARS_PER_TOKEN * 0.9);

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

  // Truncate if too long (shouldn't happen if using chunkText first)
  const truncatedText = text.slice(0, MAX_CHARS_PER_CHUNK);

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

/**
 * Split text into chunks suitable for embedding generation.
 * 
 * Chunks are split on paragraph/sentence boundaries when possible
 * to maintain semantic coherence.
 * 
 * @param text - The text to split
 * @param maxTokens - Maximum tokens per chunk (default: 8000, under 8191 limit)
 * @returns Array of text chunks
 */
export function chunkText(text: string, maxTokens = 8000): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  const chunks: string[] = [];

  // Normalize whitespace
  const normalizedText = text.replace(/\r\n/g, '\n').trim();

  // If text fits in one chunk, return as-is
  if (normalizedText.length <= maxChars) {
    return [normalizedText];
  }

  // Split into paragraphs first
  const paragraphs = normalizedText.split(/\n\s*\n/);
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;

    // If adding this paragraph would exceed the limit
    if (currentChunk.length + trimmedParagraph.length + 2 > maxChars) {
      // Save current chunk if not empty
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If paragraph itself is too long, split it by sentences
      if (trimmedParagraph.length > maxChars) {
        const sentenceChunks = splitBySentences(trimmedParagraph, maxChars);
        chunks.push(...sentenceChunks);
      } else {
        currentChunk = trimmedParagraph;
      }
    } else {
      // Add paragraph to current chunk
      if (currentChunk) {
        currentChunk += '\n\n' + trimmedParagraph;
      } else {
        currentChunk = trimmedParagraph;
      }
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Split a long paragraph into sentence-based chunks.
 * Used when a single paragraph exceeds the max chunk size.
 */
function splitBySentences(text: string, maxChars: number): string[] {
  // Split on sentence boundaries (period, exclamation, question mark followed by space or end)
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [text];
  
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    if (currentChunk.length + trimmedSentence.length + 1 > maxChars) {
      // Save current chunk
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If single sentence is too long, hard split
      if (trimmedSentence.length > maxChars) {
        const hardChunks = hardSplit(trimmedSentence, maxChars);
        chunks.push(...hardChunks);
      } else {
        currentChunk = trimmedSentence;
      }
    } else {
      if (currentChunk) {
        currentChunk += ' ' + trimmedSentence;
      } else {
        currentChunk = trimmedSentence;
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Hard split text at word boundaries when sentences are too long.
 * Last resort for very long runs of text without sentence breaks.
 */
function hardSplit(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const word of words) {
    if (currentChunk.length + word.length + 1 > maxChars) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If a single word is too long (very rare), split it
      if (word.length > maxChars) {
        for (let i = 0; i < word.length; i += maxChars) {
          chunks.push(word.slice(i, i + maxChars));
        }
      } else {
        currentChunk = word;
      }
    } else {
      if (currentChunk) {
        currentChunk += ' ' + word;
      } else {
        currentChunk = word;
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Estimate the number of tokens in a text.
 * 
 * @param text - The text to estimate
 * @returns Approximate token count
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Generate embeddings for all chunks of a text.
 * 
 * @param text - The full text to embed
 * @param openaiKey - User's OpenAI API key
 * @returns Array of {chunkIndex, chunkText, embedding} objects
 */
export async function generateChunkedEmbeddings(
  text: string,
  openaiKey: string
): Promise<Array<{
  chunkIndex: number;
  chunkText: string;
  wordCount: number;
  embedding: number[];
}>> {
  const chunks = chunkText(text);
  const results: Array<{
    chunkIndex: number;
    chunkText: string;
    wordCount: number;
    embedding: number[];
  }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = await generateEmbedding(chunk, openaiKey);
    
    results.push({
      chunkIndex: i,
      chunkText: chunk,
      wordCount: chunk.split(/\s+/).length,
      embedding,
    });

    // Small delay between API calls to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}
