CREATE TABLE bot_message_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  provider platform_provider NOT NULL,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  external_team_id text NOT NULL DEFAULT '',
  thread_id text NOT NULL,
  external_user_id text NOT NULL,
  message_id text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT bot_message_ledger_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT bot_message_ledger_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT bot_message_ledger_delivery_unique
    UNIQUE (provider, external_team_id, thread_id, external_user_id, message_id)
);

CREATE INDEX bot_message_ledger_team_id_idx ON bot_message_ledger (team_id);

ALTER TABLE bot_message_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Bot message ledger is scoped to team members"
  ON bot_message_ledger
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()))
  WITH CHECK (team_id IN (SELECT private.get_teams_for_authenticated_user()));
