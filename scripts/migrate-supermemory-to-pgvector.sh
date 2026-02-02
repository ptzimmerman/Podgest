#!/bin/bash
#
# SuperMemory → pgvector Migration Runner
#
# This script sources the .env file and runs the TypeScript migration.
# Ensures all required environment variables are set.
#
# Usage:
#   ./scripts/migrate-supermemory-to-pgvector.sh
#
# Or via npm script:
#   pnpm migrate:embeddings
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔧 Loading environment from .env..."

# Source .env file if it exists
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
  echo "   ✓ Loaded .env"
else
  echo "   ⚠️  No .env file found at $PROJECT_ROOT/.env"
  echo "   Make sure environment variables are set externally."
fi

# Verify required environment variables
MISSING_VARS=()

if [ -z "$SUPABASE_URL" ]; then
  MISSING_VARS+=("SUPABASE_URL")
fi

if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  MISSING_VARS+=("SUPABASE_SERVICE_ROLE_KEY")
fi

if [ -z "$OPENAI_API_KEY" ]; then
  MISSING_VARS+=("OPENAI_API_KEY")
fi

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
  echo ""
  echo "❌ Missing required environment variables:"
  for var in "${MISSING_VARS[@]}"; do
    echo "   - $var"
  done
  echo ""
  echo "Please set these in your .env file or export them."
  exit 1
fi

echo "   ✓ All required environment variables set"
echo ""

# Run the TypeScript migration using tsx
echo "🚀 Starting migration..."
echo ""

cd "$PROJECT_ROOT"
npx tsx scripts/migrate-supermemory-to-pgvector.ts
