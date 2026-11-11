CREATE TABLE draftmatter_project_files (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  size BIGINT NOT NULL CHECK (size BETWEEN 0 AND 1000000000),
  media_type TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'ready', 'cancelling', 'cancelled', 'deleting', 'deleted')),
  object_key TEXT NOT NULL UNIQUE,
  multipart_id TEXT,
  PRIMARY KEY (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES draftmatter_projects(workspace_id, id) ON DELETE CASCADE,
  CHECK (char_length(path) BETWEEN 1 AND 1024),
  CHECK (char_length(media_type) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX draftmatter_one_active_file_upload_path
  ON draftmatter_project_files(workspace_id, project_id, created_by, path)
  WHERE state = 'uploading';

CREATE INDEX draftmatter_project_file_expiry
  ON draftmatter_project_files(state, updated_at);

CREATE TABLE draftmatter_project_file_parts (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  etag TEXT,
  PRIMARY KEY (workspace_id, project_id, file_id, part_number),
  FOREIGN KEY (workspace_id, project_id, file_id)
    REFERENCES draftmatter_project_files(workspace_id, project_id, id) ON DELETE CASCADE
);
