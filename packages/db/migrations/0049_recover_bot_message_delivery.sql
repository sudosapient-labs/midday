ALTER TABLE public.bot_message_ledger
  ADD COLUMN IF NOT EXISTS attempt_id text,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS execution_started boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS response_text text,
  ADD COLUMN IF NOT EXISTS tool_context text,
  ADD COLUMN IF NOT EXISTS delivered_chunks integer NOT NULL DEFAULT 0;

-- Old started rows may have performed writes. Never replay them automatically.
UPDATE public.bot_message_ledger SET execution_started = true WHERE status = 'started';
ALTER TABLE public.discord_installations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.bank_accounts ALTER COLUMN created_by SET NOT NULL;
