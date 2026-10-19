CREATE TABLE invoice_status_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX invoice_status_outbox_pending_idx
  ON invoice_status_outbox (created_at) WHERE delivered_at IS NULL;
-- Worker connections use the privileged database role; no client access.
ALTER TABLE invoice_status_outbox ENABLE ROW LEVEL SECURITY;
