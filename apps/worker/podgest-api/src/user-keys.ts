/**
 * User API Keys Management
 * 
 * Fetches and decrypts user API keys from D1.
 * Keys are stored encrypted with AES-256-GCM in the user_api_keys table.
 */

import { decryptApiKey } from './encryption';
import { one } from './db';

/**
 * Decrypted user API keys
 */
export interface UserApiKeys {
  openaiKey?: string;
  anthropicKey?: string;
}

/**
 * User API keys row from database
 */
interface UserApiKeysRow {
  id: string;
  user_id: string;
  openai_key_encrypted: string | null;
  anthropic_key_encrypted: string | null;
  // SQLite booleans: INTEGER 0/1 (nullable)
  openai_valid: number | null;
  anthropic_valid: number | null;
  openai_validated_at: string | null;
  anthropic_validated_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * Fetch and decrypt a user's API keys from D1.
 * 
 * @param db - D1 database binding
 * @param userId - User ID to fetch keys for
 * @param encryptionKey - 32-byte hex encryption key for decryption
 * @returns Decrypted API keys (undefined for keys not set)
 */
export async function getUserApiKeys(
  db: D1Database,
  userId: string,
  encryptionKey: string
): Promise<UserApiKeys> {
  if (!userId) {
    throw new Error('User ID is required');
  }

  if (!encryptionKey) {
    throw new Error('Encryption key is required');
  }

  try {
    // Fetch user's API keys from database
    const row = await one<UserApiKeysRow>(
      db,
      `SELECT * FROM user_api_keys WHERE user_id = ?`,
      userId
    );

    // No keys configured for this user
    if (!row) {
      return {};
    }

    const keys: UserApiKeys = {};

    // Decrypt each key if present
    if (row.openai_key_encrypted) {
      try {
        keys.openaiKey = await decryptApiKey(row.openai_key_encrypted, encryptionKey);
      } catch (error) {
        console.error(`[UserKeys] Failed to decrypt OpenAI key for user ${userId}:`, error);
        // Don't throw - return undefined for this key
      }
    }

    if (row.anthropic_key_encrypted) {
      try {
        keys.anthropicKey = await decryptApiKey(row.anthropic_key_encrypted, encryptionKey);
      } catch (error) {
        console.error(`[UserKeys] Failed to decrypt Anthropic key for user ${userId}:`, error);
      }
    }

    return keys;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Error fetching user API keys: ${error.message}`);
    }
    throw new Error('Error fetching user API keys: Unknown error');
  }
}

/**
 * Check if a user has a specific API key configured.
 * 
 * @param db - D1 database binding
 * @param userId - User ID to check
 * @param keyType - Which key to check for
 * @returns True if the key exists (may not be valid)
 */
export async function hasApiKey(
  db: D1Database,
  userId: string,
  keyType: 'openai' | 'anthropic'
): Promise<boolean> {
  try {
    // keyType is constrained by the type system, so the column name is safe to interpolate
    const column = `${keyType}_key_encrypted`;

    const row = await one<Record<string, string | null>>(
      db,
      `SELECT ${column} FROM user_api_keys WHERE user_id = ?`,
      userId
    );

    if (!row) {
      return false;
    }

    return row[column] !== null;
  } catch {
    return false;
  }
}

/**
 * Get user API key status (which keys are set and valid).
 * 
 * @param db - D1 database binding
 * @param userId - User ID to check
 * @returns Status of each API key
 */
export async function getApiKeyStatus(
  db: D1Database,
  userId: string
): Promise<{
  openai: { set: boolean; valid: boolean; validatedAt: string | null };
  anthropic: { set: boolean; valid: boolean; validatedAt: string | null };
}> {
  const defaultStatus = { set: false, valid: false, validatedAt: null };

  try {
    const row = await one<UserApiKeysRow>(
      db,
      `SELECT openai_key_encrypted, anthropic_key_encrypted,
              openai_valid, anthropic_valid,
              openai_validated_at, anthropic_validated_at
       FROM user_api_keys WHERE user_id = ?`,
      userId
    );

    if (!row) {
      return {
        openai: defaultStatus,
        anthropic: defaultStatus,
      };
    }

    return {
      openai: {
        set: row.openai_key_encrypted !== null,
        valid: !!row.openai_valid,
        validatedAt: row.openai_validated_at,
      },
      anthropic: {
        set: row.anthropic_key_encrypted !== null,
        valid: !!row.anthropic_valid,
        validatedAt: row.anthropic_validated_at,
      },
    };
  } catch {
    return {
      openai: defaultStatus,
      anthropic: defaultStatus,
    };
  }
}

/**
 * Detailed validation result with specific error information
 */
export interface KeyValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: 'invalid_key' | 'quota_exceeded' | 'rate_limited' | 'network_error' | 'unknown';
}

/**
 * Validate an OpenAI API key with detailed error reporting.
 */
export async function validateOpenAIKeyDetailed(apiKey: string): Promise<KeyValidationResult> {
  if (!apiKey) {
    return { valid: false, error: "API key is required", errorCode: 'invalid_key' };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (response.ok) {
      return { valid: true };
    }

    // Parse error response
    try {
      const errorData = await response.json() as { error?: { message?: string; code?: string; type?: string } };
      const errorMsg = errorData.error?.message || `HTTP ${response.status}`;
      const errorType = errorData.error?.type || errorData.error?.code;

      if (response.status === 401) {
        return { valid: false, error: "Invalid API key", errorCode: 'invalid_key' };
      }
      if (response.status === 429 || errorType === 'insufficient_quota') {
        if (errorMsg.includes('quota') || errorType === 'insufficient_quota') {
          return { valid: false, error: "API key quota exceeded. Please add credits to your OpenAI account.", errorCode: 'quota_exceeded' };
        }
        return { valid: false, error: "Rate limited. Please try again later.", errorCode: 'rate_limited' };
      }
      return { valid: false, error: errorMsg, errorCode: 'unknown' };
    } catch {
      return { valid: false, error: `HTTP ${response.status}`, errorCode: 'unknown' };
    }
  } catch (e) {
    return { valid: false, error: "Network error - could not reach OpenAI", errorCode: 'network_error' };
  }
}

/**
 * Validate an Anthropic API key with detailed error reporting.
 */
export async function validateAnthropicKeyDetailed(apiKey: string): Promise<KeyValidationResult> {
  if (!apiKey) {
    return { valid: false, error: "API key is required", errorCode: 'invalid_key' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    // 200 = valid
    if (response.ok) {
      return { valid: true };
    }

    try {
      const errorData = await response.json() as { error?: { message?: string; type?: string } };
      const errorMsg = errorData.error?.message || `HTTP ${response.status}`;
      const errorType = errorData.error?.type;

      // Check for credit/billing issues in any response (including 400)
      if (errorMsg.toLowerCase().includes('credit balance') || errorMsg.toLowerCase().includes('billing')) {
        return { valid: false, error: "API key has no credits. Please add credits to your Anthropic account.", errorCode: 'quota_exceeded' };
      }
      
      // 400 with other errors = valid key but bad request
      if (response.status === 400 && errorType !== 'invalid_request_error') {
        return { valid: true };
      }
      // 400 with invalid_request_error but not credit related = probably valid key
      if (response.status === 400 && !errorMsg.toLowerCase().includes('credit')) {
        return { valid: true };
      }

      if (response.status === 401 || errorType === 'authentication_error') {
        return { valid: false, error: "Invalid API key", errorCode: 'invalid_key' };
      }
      if (response.status === 429) {
        return { valid: false, error: "Rate limited. Please try again later.", errorCode: 'rate_limited' };
      }
      return { valid: false, error: errorMsg, errorCode: 'unknown' };
    } catch {
      return { valid: false, error: `HTTP ${response.status}`, errorCode: 'unknown' };
    }
  } catch (e) {
    return { valid: false, error: "Network error - could not reach Anthropic", errorCode: 'network_error' };
  }
}

/**
 * Validate an OpenAI API key by making a test API call.
 * @deprecated Use validateOpenAIKeyDetailed for better error messages
 */
export async function validateOpenAIKey(apiKey: string): Promise<boolean> {
  const result = await validateOpenAIKeyDetailed(apiKey);
  return result.valid;
}

/**
 * Validate an Anthropic API key by making a test API call.
 * @deprecated Use validateAnthropicKeyDetailed for better error messages
 */
export async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  const result = await validateAnthropicKeyDetailed(apiKey);
  return result.valid;
}

