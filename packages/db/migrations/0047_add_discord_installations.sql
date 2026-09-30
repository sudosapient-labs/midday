CREATE TABLE discord_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  guild_id text NOT NULL,
  team_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT discord_installations_guild_id_unique UNIQUE (guild_id),
  CONSTRAINT discord_installations_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT discord_installations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX discord_installations_team_id_idx
  ON discord_installations (team_id);

ALTER TABLE discord_installations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Discord installations can be managed by team members"
  ON discord_installations
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (team_id IN (SELECT private.get_teams_for_authenticated_user()))
  WITH CHECK (team_id IN (SELECT private.get_teams_for_authenticated_user()));
