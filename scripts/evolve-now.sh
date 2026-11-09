#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
echo "=== Triggering manual evolution cycle ==="
npx tsx src/worker/evolve-now.ts
