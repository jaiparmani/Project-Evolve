#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "=== Project Evolve — Starting ==="

# Run migration
echo "→ Running database migration..."
npx tsx src/db/migrate.ts

# Install evolving-app dependencies
if [ -f evolving-app/package.json ]; then
  echo "→ Installing evolving-app dependencies..."
  (cd evolving-app && npm install --ignore-scripts 2>&1 || true)
fi

# Start control room and worker
echo "→ Starting Control Room on port ${PORT:-3000}..."
echo "→ Starting Evolution Worker..."

npx concurrently \
  --names "server,worker" \
  --prefix-colors "cyan,magenta" \
  "npx tsx src/web/server.ts" \
  "npx tsx src/worker/index.ts"
