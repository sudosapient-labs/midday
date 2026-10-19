-- Existing exhausted rows become eligible again; their failure type was unknown.
ALTER TABLE transaction_email_outbox
  ADD COLUMN permanent_failures integer NOT NULL DEFAULT 0;
