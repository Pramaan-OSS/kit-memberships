ALTER TABLE memberships ADD COLUMN operation_started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE memberships ADD COLUMN action_started_at timestamptz;
