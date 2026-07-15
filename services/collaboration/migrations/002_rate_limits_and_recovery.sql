CREATE TABLE draftmatter_rate_limit_events (
  principal_key TEXT NOT NULL,
  category TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX draftmatter_rate_limit_window
  ON draftmatter_rate_limit_events(principal_key, category, occurred_at);

CREATE TABLE draftmatter_recovery_checkpoints (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, snapshot_id)
    REFERENCES draftmatter_collaboration_snapshots(workspace_id, project_id, id) ON DELETE RESTRICT
);

CREATE INDEX draftmatter_recovery_project_time
  ON draftmatter_recovery_checkpoints(workspace_id, project_id, created_at DESC, id DESC);
