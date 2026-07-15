CREATE TABLE IF NOT EXISTS draftmatter_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE draftmatter_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (id ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$')
);

CREATE TABLE draftmatter_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  CHECK (id ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE TABLE draftmatter_memberships (
  workspace_id TEXT NOT NULL REFERENCES draftmatter_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES draftmatter_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE UNIQUE INDEX draftmatter_one_active_owner
  ON draftmatter_memberships(workspace_id)
  WHERE role = 'owner' AND revoked_at IS NULL;

CREATE TABLE draftmatter_projects (
  workspace_id TEXT NOT NULL REFERENCES draftmatter_workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id),
  CHECK (id ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  CHECK (char_length(name) BETWEEN 1 AND 300)
);

CREATE TABLE draftmatter_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES draftmatter_workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
  email TEXT,
  token_digest TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES draftmatter_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT REFERENCES draftmatter_users(id),
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE TABLE draftmatter_audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES draftmatter_workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (char_length(action) BETWEEN 1 AND 120)
);

CREATE INDEX draftmatter_audit_workspace_time
  ON draftmatter_audit_events(workspace_id, occurred_at DESC, id DESC);

CREATE TABLE draftmatter_entitlements (
  workspace_id TEXT PRIMARY KEY REFERENCES draftmatter_workspaces(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'self-hosted',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'past_due', 'suspended', 'cancelled')),
  seat_limit INTEGER NOT NULL DEFAULT 5 CHECK (seat_limit > 0),
  storage_limit_bytes BIGINT NOT NULL DEFAULT 1073741824 CHECK (storage_limit_bytes > 0),
  source TEXT NOT NULL DEFAULT 'local',
  external_customer_id TEXT,
  external_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE draftmatter_webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE draftmatter_collaboration_projects (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  next_sequence BIGINT NOT NULL DEFAULT 1,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES draftmatter_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE draftmatter_collaboration_updates (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload BYTEA NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  PRIMARY KEY (workspace_id, project_id, sequence),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES draftmatter_collaboration_projects(workspace_id, project_id) ON DELETE CASCADE
);

CREATE TABLE draftmatter_collaboration_snapshots (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  through_sequence BIGINT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'deleting')),
  PRIMARY KEY (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES draftmatter_collaboration_projects(workspace_id, project_id) ON DELETE CASCADE
);

CREATE INDEX draftmatter_snapshot_latest
  ON draftmatter_collaboration_snapshots(workspace_id, project_id, created_at DESC, id DESC)
  WHERE state = 'ready';

CREATE TABLE draftmatter_deletion_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES draftmatter_workspaces(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execute_after TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'completed', 'failed', 'cancelled')),
  failure TEXT
);
