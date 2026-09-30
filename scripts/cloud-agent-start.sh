#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="${HOME}/.bun/bin:${PATH}"

./scripts/cloud-agent-docker.sh

if ! docker ps --format '{{.Names}}' | grep -q '^midday-redis$'; then
  docker rm -f midday-redis >/dev/null 2>&1 || true
  docker run -d --name midday-redis --network host redis:7.4-alpine \
    redis-server --port 6379 --appendonly yes >/dev/null
fi

for _ in $(seq 1 30); do
  if docker exec midday-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 1
done

./scripts/cloud-agent-supabase.sh
./scripts/cloud-agent-env.sh
