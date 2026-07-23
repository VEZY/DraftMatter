CREATE TABLE draftmatter_user_onboarding (
  user_id TEXT PRIMARY KEY REFERENCES draftmatter_users(id) ON DELETE CASCADE,
  completed_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
