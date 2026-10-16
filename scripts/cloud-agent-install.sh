#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="${HOME}/.bun/bin:${PATH}"

bun install

if ! command -v bunx >/dev/null 2>&1; then
  echo "bun is required" >&2
  exit 1
fi

if ! grep -q '"supabase"' package.json; then
  bun add -D supabase@2.115.0
fi

./scripts/cloud-agent-docker.sh
./scripts/cloud-agent-supabase.sh
./scripts/cloud-agent-env.sh
