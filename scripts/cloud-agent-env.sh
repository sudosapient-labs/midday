#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="${HOME}/.bun/bin:${PATH}"

for _ in $(seq 1 60); do
  if status_env="$(bunx supabase status -o env 2>/dev/null | grep -v '^WARN')" \
    && [[ "$status_env" == *PUBLISHABLE_KEY=* ]]; then
    eval "$status_env"
    break
  fi
  sleep 2
done

if [[ -z "${PUBLISHABLE_KEY:-}" ]]; then
  echo "Supabase status is missing PUBLISHABLE_KEY" >&2
  exit 1
fi

SERVER_ACTIONS_KEY="${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
FILE_KEY_SECRET="${FILE_KEY_SECRET:-local-dev-file-key-secret}"
INVOICE_JWT_SECRET="${INVOICE_JWT_SECRET:-local-dev-invoice-jwt-secret}"
MIDDAY_ENCRYPTION_KEY="${MIDDAY_ENCRYPTION_KEY:-local-dev-midday-encryption-key}"

cat > .env.compose.local <<EOF
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_KEY}
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_INTERNAL_URL=http://127.0.0.1:54321
SUPABASE_AUTH_ISSUER=http://127.0.0.1:54321/auth/v1
SUPABASE_SECRET_KEY=${SECRET_KEY}
SUPABASE_JWT_SECRET=${JWT_SECRET}

DATABASE_PRIMARY_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_PRIMARY_POOLER_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_SESSION_POOLER=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_SSL_DISABLED=true

REDIS_URL=redis://127.0.0.1:6379
REDIS_QUEUE_URL=redis://127.0.0.1:6379

R2_ENDPOINT=http://127.0.0.1:54321/storage/v1/s3
R2_ACCESS_KEY_ID=${S3_PROTOCOL_ACCESS_KEY_ID}
R2_SECRET_ACCESS_KEY=${S3_PROTOCOL_ACCESS_KEY_SECRET}
R2_BUCKET_NAME=apps

NEXT_PUBLIC_URL=http://localhost:3001
NEXT_PUBLIC_API_URL=http://localhost:3003
API_INTERNAL_URL=http://localhost:3003
MIDDAY_DASHBOARD_URL=http://localhost:3001
MIDDAY_API_URL=http://localhost:3003
ALLOWED_API_ORIGINS=http://localhost:3001
DEPLOYMENT_MODE=company
NEXT_PUBLIC_DESKTOP_SCHEME=midday-dev
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${SERVER_ACTIONS_KEY}

FILE_KEY_SECRET=${FILE_KEY_SECRET}
INVOICE_JWT_SECRET=${INVOICE_JWT_SECRET}
MIDDAY_ENCRYPTION_KEY=${MIDDAY_ENCRYPTION_KEY}
COMPOSIO_API_KEY=local-dev-composio-key
TELEGRAM_BOT_TOKEN=0000000000:local-dev-telegram-token
WHATSAPP_ACCESS_TOKEN=local-dev-whatsapp-token
WHATSAPP_PHONE_NUMBER_ID=local-dev-phone-number-id
WHATSAPP_APP_SECRET=local-dev-whatsapp-app-secret
WHATSAPP_VERIFY_TOKEN=local-dev-whatsapp-verify-token
SLACK_SIGNING_SECRET=local-dev-slack-signing-secret
SENDBLUE_API_KEY=local-dev-sendblue-api-key
SENDBLUE_API_SECRET=local-dev-sendblue-api-secret
SENDBLUE_FROM_NUMBER=+10000000000
RESEND_API_KEY=re_local_dev_key
EOF

write_dev_env() {
  local target="$1"
  cat > "$target" <<EOF
DEPLOYMENT_MODE=company
NEXT_PUBLIC_URL=http://localhost:3001
NEXT_PUBLIC_API_URL=http://localhost:3003
API_INTERNAL_URL=http://localhost:3003
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_KEY}
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_INTERNAL_URL=http://127.0.0.1:54321
SUPABASE_AUTH_ISSUER=http://127.0.0.1:54321/auth/v1
SUPABASE_SECRET_KEY=${SECRET_KEY}
SUPABASE_JWT_SECRET=${JWT_SECRET}
DATABASE_PRIMARY_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_PRIMARY_POOLER_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_SESSION_POOLER=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_SSL_DISABLED=true
REDIS_URL=redis://127.0.0.1:6379
REDIS_QUEUE_URL=redis://127.0.0.1:6379
R2_ENDPOINT=http://127.0.0.1:54321/storage/v1/s3
R2_ACCESS_KEY_ID=${S3_PROTOCOL_ACCESS_KEY_ID}
R2_SECRET_ACCESS_KEY=${S3_PROTOCOL_ACCESS_KEY_SECRET}
R2_BUCKET_NAME=apps
MIDDAY_DASHBOARD_URL=http://localhost:3001
MIDDAY_API_URL=http://localhost:3003
ALLOWED_API_ORIGINS=http://localhost:3001
NEXT_PUBLIC_DESKTOP_SCHEME=midday-dev
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${SERVER_ACTIONS_KEY}
FILE_KEY_SECRET=${FILE_KEY_SECRET}
INVOICE_JWT_SECRET=${INVOICE_JWT_SECRET}
MIDDAY_ENCRYPTION_KEY=${MIDDAY_ENCRYPTION_KEY}
COMPOSIO_API_KEY=local-dev-composio-key
TELEGRAM_BOT_TOKEN=0000000000:local-dev-telegram-token
WHATSAPP_ACCESS_TOKEN=local-dev-whatsapp-token
WHATSAPP_PHONE_NUMBER_ID=local-dev-phone-number-id
WHATSAPP_APP_SECRET=local-dev-whatsapp-app-secret
WHATSAPP_VERIFY_TOKEN=local-dev-whatsapp-verify-token
SLACK_SIGNING_SECRET=local-dev-slack-signing-secret
SENDBLUE_API_KEY=local-dev-sendblue-api-key
SENDBLUE_API_SECRET=local-dev-sendblue-api-secret
SENDBLUE_FROM_NUMBER=+10000000000
RESEND_API_KEY=re_local_dev_key
EOF
}

write_dev_env apps/api/.env
write_dev_env apps/dashboard/.env
write_dev_env apps/worker/.env
