#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="${HOME}/.bun/bin:${PATH}"

LAST_MIGRATION="supabase/migrations/20260715000400_fix_local_schema.sql"
MIGRATION_BACKUP="/tmp/midday-last-supabase-migration.sql"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

restore_last_migration() {
  if [[ -f "$MIGRATION_BACKUP" ]]; then
    mv "$MIGRATION_BACKUP" "$LAST_MIGRATION"
  fi
}

bunx supabase stop --no-backup >/dev/null 2>&1 || true

if [[ -f "$LAST_MIGRATION" ]]; then
  cp "$LAST_MIGRATION" "$MIGRATION_BACKUP"
  rm "$LAST_MIGRATION"
fi

if ! bunx supabase start; then
  restore_last_migration
  exit 1
fi

(
  cd packages/db
  DATABASE_SESSION_POOLER="$DATABASE_URL" bun run db:bootstrap

  if ! PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tracker_projects'" \
    | grep -q 1; then
    DATABASE_SESSION_POOLER="$DATABASE_URL" bun run db:push
  fi
)

if [[ -f "$MIGRATION_BACKUP" ]]; then
  restore_last_migration
  bunx supabase migration up
fi

for _ in $(seq 1 60); do
  if bunx supabase status -o env 2>/dev/null | grep -q '^PUBLISHABLE_KEY='; then
    break
  fi
  sleep 2
done

if ! bunx supabase status -o env 2>/dev/null | grep -q '^PUBLISHABLE_KEY='; then
  echo "Supabase did not become ready" >&2
  exit 1
fi
