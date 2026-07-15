CREATE TABLE draftmatter_workspace_policies (
  workspace_id TEXT PRIMARY KEY REFERENCES draftmatter_workspaces(id) ON DELETE CASCADE,
  retain_latest_snapshots INTEGER NOT NULL DEFAULT 20 CHECK (retain_latest_snapshots > 0),
  snapshot_max_age_days INTEGER NOT NULL DEFAULT 30 CHECK (snapshot_max_age_days >= 0),
  retain_latest_backups INTEGER NOT NULL DEFAULT 7 CHECK (retain_latest_backups > 0),
  backup_max_age_days INTEGER NOT NULL DEFAULT 90 CHECK (backup_max_age_days >= 1),
  deletion_grace_hours INTEGER NOT NULL DEFAULT 168 CHECK (deletion_grace_hours BETWEEN 1 AND 720),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE draftmatter_collaboration_backups (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  object_key TEXT NOT NULL UNIQUE,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state_sha256 TEXT NOT NULL CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  verified_at TIMESTAMPTZ,
  last_restored_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'deleting')),
  PRIMARY KEY (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES draftmatter_collaboration_projects(workspace_id, project_id) ON DELETE CASCADE
);

CREATE INDEX draftmatter_backup_latest
  ON draftmatter_collaboration_backups(workspace_id, project_id, created_at DESC, id DESC)
  WHERE state = 'ready';

CREATE UNIQUE INDEX draftmatter_one_pending_deletion
  ON draftmatter_deletion_requests(workspace_id)
  WHERE status IN ('scheduled', 'running', 'failed');
