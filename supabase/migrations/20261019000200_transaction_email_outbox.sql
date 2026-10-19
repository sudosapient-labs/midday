CREATE TABLE transaction_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX transaction_email_outbox_pending_idx
  ON transaction_email_outbox (created_at) WHERE delivered_at IS NULL;
CREATE INDEX transaction_email_outbox_team_id_idx ON transaction_email_outbox (team_id);
ALTER TABLE transaction_email_outbox ENABLE ROW LEVEL SECURITY;
