/**
 * SuperMemory → pgvector Migration Script
 * 
 * Backfills embeddings for all existing podcast transcripts.
 * Since SuperMemory stored whole documents (not our own embeddings),
 * this script generates new embeddings from source transcripts.
 * 
 * Features:
 * - Reads transcripts from Supabase Storage
 * - Chunks text into ~500 token segments with overlap
 * - Generates embeddings using OpenAI text-embedding-3-small
 * - Inserts into transcript_embeddings table
 * - Incremental: skips episodes that already have embeddings
 * - Rate limiting to stay within OpenAI limits
 * 
 * Usage:
 *   npx tsx scripts/migrate-supermemory-to-pgvector.ts
 * 
 * Or via npm script:
 *   pnpm migrate:embeddings
 * 
 * Environment variables (from .env):
 *   SUPABASE_URL - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Service role key for admin access
 *   OPENAI_API_KEY - OpenAI API key for embeddings
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Configuration
const CHUNK_SIZE = 500;       // ~500 words per chunk
const CHUNK_OVERLAP = 50;     // 50 word overlap between chunks
const BATCH_SIZE = 20;        // Embeddings per API call (OpenAI supports up to 2048)
const RATE_LIMIT_DELAY = 100; // ms between API calls
const MAX_RETRIES = 3;        // Retries for failed API calls

// Interfaces
interface Transcription {
  id: string;
  episode_id: string;
  transcript_storage_path: string;
  status: string;
}

interface Episode {
  id: string;
  title: string;
  feed_url: string;
}

interface Subscription {
  user_id: string;
  feed_url: string;
}

interface TranscriptData {
  text: string;
  segments?: Array<{ text: string }>;
}

interface MigrationStats {
  totalTranscriptions: number;
  skipped: number;
  processed: number;
  failed: number;
  totalChunks: number;
  totalTokens: number;
  estimatedCost: number;
}

// Initialize clients
function initClients() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!supabaseUrl || !supabaseKey || !openaiKey) {
    console.error('❌ Missing required environment variables:');
    if (!supabaseUrl) console.error('   - SUPABASE_URL');
    if (!supabaseKey) console.error('   - SUPABASE_SERVICE_ROLE_KEY');
    if (!openaiKey) console.error('   - OPENAI_API_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  const openai = new OpenAI({ apiKey: openaiKey });

  return { supabase, openai };
}

/**
 * Chunk text into overlapping segments of approximately CHUNK_SIZE words
 */
function chunkText(text: string): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    const chunk = words.slice(i, i + CHUNK_SIZE).join(' ');
    // Skip chunks that are too small (less than 50 chars / ~10 words)
    if (chunk.length >= 50) {
      chunks.push(chunk);
    }
    // Stop if we've reached the end
    if (i + CHUNK_SIZE >= words.length) break;
  }
  
  return chunks;
}

/**
 * Generate embeddings for a batch of text chunks
 */
async function generateEmbeddings(
  openai: OpenAI,
  texts: string[],
  retries = 0
): Promise<{ embeddings: number[][]; tokens: number }> {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });

    return {
      embeddings: response.data.map(d => d.embedding),
      tokens: response.usage.total_tokens,
    };
  } catch (error) {
    if (retries < MAX_RETRIES) {
      const delay = Math.pow(2, retries) * 1000; // Exponential backoff
      console.warn(`    ⚠️  Embedding API error, retrying in ${delay}ms...`);
      await sleep(delay);
      return generateEmbeddings(openai, texts, retries + 1);
    }
    throw error;
  }
}

/**
 * Download transcript from Supabase Storage
 */
async function downloadTranscript(
  supabase: SupabaseClient,
  storagePath: string
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('transcripts')
    .download(storagePath);

  if (error || !data) {
    console.error(`    ❌ Failed to download transcript: ${error?.message}`);
    return null;
  }

  const text = await data.text();
  
  try {
    // Transcripts are stored as JSON with a "text" field
    const parsed = JSON.parse(text) as TranscriptData;
    return parsed.text || null;
  } catch {
    // If not JSON, return raw text
    return text;
  }
}

/**
 * Check if episode already has embeddings
 */
async function hasExistingEmbeddings(
  supabase: SupabaseClient,
  episodeId: string
): Promise<boolean> {
  const { count, error } = await supabase
    .from('transcript_embeddings')
    .select('*', { count: 'exact', head: true })
    .eq('episode_id', episodeId);

  if (error) {
    console.error(`    ⚠️  Error checking existing embeddings: ${error.message}`);
    return false;
  }

  return (count ?? 0) > 0;
}

/**
 * Get user_id for an episode via its subscription
 */
async function getUserIdForEpisode(
  supabase: SupabaseClient,
  feedUrl: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('feed_url', feedUrl)
    .limit(1)
    .single();

  if (error || !data) {
    return null;
  }

  return data.user_id;
}

/**
 * Insert embedding rows into the database
 */
async function insertEmbeddings(
  supabase: SupabaseClient,
  userId: string,
  episodeId: string,
  chunks: string[],
  embeddings: number[][]
): Promise<boolean> {
  const rows = chunks.map((chunk, i) => ({
    user_id: userId,
    episode_id: episodeId,
    chunk_index: i,
    chunk_text: chunk,
    word_count: chunk.split(/\s+/).length,
    embedding: `[${embeddings[i].join(',')}]`, // pgvector expects array string
  }));

  const { error } = await supabase
    .from('transcript_embeddings')
    .insert(rows);

  if (error) {
    console.error(`    ❌ Insert error: ${error.message}`);
    return false;
  }

  return true;
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format duration
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       SuperMemory → pgvector Migration Script                  ║');
  console.log('║       Backfilling embeddings for existing transcripts          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  const startTime = Date.now();
  const { supabase, openai } = initClients();

  const stats: MigrationStats = {
    totalTranscriptions: 0,
    skipped: 0,
    processed: 0,
    failed: 0,
    totalChunks: 0,
    totalTokens: 0,
    estimatedCost: 0,
  };

  // 1. Fetch all completed transcriptions
  console.log('📋 Fetching completed transcriptions...');
  
  const { data: transcriptions, error: fetchError } = await supabase
    .from('transcriptions')
    .select('id, episode_id, transcript_storage_path, status')
    .eq('status', 'completed')
    .not('transcript_storage_path', 'is', null)
    .order('created_at', { ascending: true });

  if (fetchError) {
    console.error('❌ Failed to fetch transcriptions:', fetchError.message);
    process.exit(1);
  }

  stats.totalTranscriptions = transcriptions?.length || 0;
  console.log(`   Found ${stats.totalTranscriptions} completed transcriptions\n`);

  if (!transcriptions || transcriptions.length === 0) {
    console.log('✅ No transcriptions to process. Done!');
    return;
  }

  // 2. Process each transcription
  console.log('🔄 Processing transcriptions...\n');

  for (let i = 0; i < transcriptions.length; i++) {
    const t = transcriptions[i] as Transcription;
    const progress = `[${i + 1}/${transcriptions.length}]`;
    
    console.log(`${progress} Episode: ${t.episode_id}`);
    console.log(`         Path: ${t.transcript_storage_path}`);

    // 2a. Check if already migrated
    const hasEmbeddings = await hasExistingEmbeddings(supabase, t.episode_id);
    if (hasEmbeddings) {
      console.log('         ⏭️  Already has embeddings, skipping\n');
      stats.skipped++;
      continue;
    }

    // 2b. Get episode metadata to find user_id
    const { data: episodes } = await supabase
      .from('episodes')
      .select('id, title, feed_url')
      .eq('id', t.episode_id)
      .single();

    if (!episodes) {
      console.log('         ❌ Episode not found, skipping\n');
      stats.failed++;
      continue;
    }

    const episode = episodes as Episode;
    console.log(`         Title: ${episode.title.substring(0, 60)}...`);

    const userId = await getUserIdForEpisode(supabase, episode.feed_url);
    if (!userId) {
      console.log('         ❌ No subscription found for feed, skipping\n');
      stats.failed++;
      continue;
    }

    // 2c. Download transcript
    const transcriptText = await downloadTranscript(supabase, t.transcript_storage_path);
    if (!transcriptText) {
      console.log('         ❌ Failed to download transcript, skipping\n');
      stats.failed++;
      continue;
    }

    console.log(`         📄 Transcript: ${transcriptText.length} chars`);

    // 2d. Chunk the transcript
    const chunks = chunkText(transcriptText);
    console.log(`         🧩 Chunks: ${chunks.length} (${CHUNK_SIZE} words each)`);

    if (chunks.length === 0) {
      console.log('         ⚠️  No valid chunks generated, skipping\n');
      stats.failed++;
      continue;
    }

    // 2e. Generate embeddings in batches
    const embeddings: number[][] = [];
    let episodeTokens = 0;

    for (let j = 0; j < chunks.length; j += BATCH_SIZE) {
      const batch = chunks.slice(j, j + BATCH_SIZE);
      const batchNum = Math.floor(j / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
      
      process.stdout.write(`         🔢 Generating embeddings batch ${batchNum}/${totalBatches}...`);

      try {
        const { embeddings: batchEmbeddings, tokens } = await generateEmbeddings(openai, batch);
        embeddings.push(...batchEmbeddings);
        episodeTokens += tokens;
        console.log(` ✓ (${tokens} tokens)`);
      } catch (error) {
        console.log(' ❌');
        console.error(`         Error: ${error instanceof Error ? error.message : error}`);
        break;
      }

      // Rate limit between batches
      if (j + BATCH_SIZE < chunks.length) {
        await sleep(RATE_LIMIT_DELAY);
      }
    }

    // Check if we got all embeddings
    if (embeddings.length !== chunks.length) {
      console.log(`         ❌ Embedding count mismatch (${embeddings.length}/${chunks.length}), skipping\n`);
      stats.failed++;
      continue;
    }

    // 2f. Insert into pgvector
    process.stdout.write('         💾 Inserting into database...');
    const inserted = await insertEmbeddings(supabase, userId, t.episode_id, chunks, embeddings);
    
    if (inserted) {
      console.log(' ✓');
      stats.processed++;
      stats.totalChunks += chunks.length;
      stats.totalTokens += episodeTokens;
    } else {
      console.log(' ❌');
      stats.failed++;
    }

    console.log('');
    
    // Rate limit between episodes
    await sleep(RATE_LIMIT_DELAY);
  }

  // 3. Summary
  const duration = Date.now() - startTime;
  
  // text-embedding-3-small costs $0.02 per 1M tokens
  stats.estimatedCost = (stats.totalTokens / 1_000_000) * 0.02;

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                     MIGRATION COMPLETE                          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('📊 Summary:');
  console.log(`   Total transcriptions:  ${stats.totalTranscriptions}`);
  console.log(`   Processed:             ${stats.processed}`);
  console.log(`   Skipped (existing):    ${stats.skipped}`);
  console.log(`   Failed:                ${stats.failed}`);
  console.log('');
  console.log('📈 Metrics:');
  console.log(`   Total chunks created:  ${stats.totalChunks}`);
  console.log(`   Total tokens used:     ${stats.totalTokens.toLocaleString()}`);
  console.log(`   Estimated cost:        $${stats.estimatedCost.toFixed(4)}`);
  console.log(`   Duration:              ${formatDuration(duration)}`);
  console.log('');

  if (stats.failed > 0) {
    console.log('⚠️  Some transcriptions failed. Re-run to retry them.');
  } else if (stats.processed > 0) {
    console.log('✅ All transcriptions migrated successfully!');
  } else if (stats.skipped === stats.totalTranscriptions) {
    console.log('✅ All transcriptions already migrated. Nothing to do!');
  }
}

// Run migration
migrate().catch((error) => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});
