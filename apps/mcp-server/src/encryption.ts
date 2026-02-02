/**
 * AES-256-GCM Encryption Utilities for BYOK API Keys
 * 
 * Uses Web Crypto API for Cloudflare Workers compatibility.
 * 
 * Encrypted format: base64(iv + ciphertext + authTag)
 * - IV: 12 bytes (96 bits) - recommended for GCM
 * - Ciphertext: variable length
 * - AuthTag: 16 bytes (128 bits) - included in ciphertext by Web Crypto
 */

/**
 * Derive a CryptoKey from a hex string encryption key.
 * The encryption key should be generated with: openssl rand -hex 32
 */
async function deriveKey(encryptionKey: string): Promise<CryptoKey> {
  // Convert hex string to Uint8Array
  const keyBytes = new Uint8Array(
    encryptionKey.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );

  if (keyBytes.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (64 hex characters)');
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Decrypt an API key using AES-256-GCM.
 * 
 * @param encryptedKey - Base64-encoded encrypted string (iv + ciphertext)
 * @param encryptionKey - 32-byte hex-encoded encryption key (must match encryption)
 * @returns Decrypted plaintext API key
 */
export async function decryptApiKey(
  encryptedKey: string,
  encryptionKey: string
): Promise<string> {
  if (!encryptedKey) {
    throw new Error('Cannot decrypt empty key');
  }

  if (!encryptionKey) {
    throw new Error('Encryption key is required');
  }

  try {
    const key = await deriveKey(encryptionKey);
    
    // Decode base64
    const combined = Uint8Array.from(atob(encryptedKey), c => c.charCodeAt(0));
    
    // Extract IV (first 12 bytes) and ciphertext (rest)
    if (combined.length < 12 + 16) {
      // Minimum: 12 byte IV + 16 byte auth tag
      throw new Error('Invalid encrypted data: too short');
    }
    
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    
    // Decrypt with AES-256-GCM
    const plainBytes = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        tagLength: 128,
      },
      key,
      ciphertext
    );
    
    // Decode UTF-8 plaintext
    const decoder = new TextDecoder();
    return decoder.decode(plainBytes);
  } catch (error) {
    if (error instanceof Error) {
      // Check for auth tag failure (tampered or wrong key)
      if (error.message.includes('operation failed') || 
          error.name === 'OperationError') {
        throw new Error('Decryption failed: Invalid key or corrupted data');
      }
      throw new Error(`Decryption failed: ${error.message}`);
    }
    throw new Error('Decryption failed: Unknown error');
  }
}
