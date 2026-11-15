ALTER TABLE draftmatter_project_files ADD COLUMN expected_version_id TEXT;

CREATE TABLE draftmatter_project_file_heads (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version_id TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (workspace_id, project_id, path),
  FOREIGN KEY (workspace_id, project_id) REFERENCES draftmatter_projects(workspace_id, id) ON DELETE CASCADE,
  CHECK (char_length(path) BETWEEN 1 AND 1024),
  CHECK (char_length(version_id) BETWEEN 1 AND 256)
);

-- Existing immutable versions acquire one deterministic current head. A deleted
-- latest version stays a tombstone instead of reviving an older version.
INSERT INTO draftmatter_project_file_heads(workspace_id, project_id, path, version_id, deleted)
SELECT DISTINCT ON (workspace_id, project_id, path)
  workspace_id, project_id, path,
  CASE WHEN state = 'ready' THEN id ELSE 'deleted-' || id END,
  state <> 'ready'
FROM draftmatter_project_files
WHERE state IN ('ready', 'deleting', 'deleted')
ORDER BY workspace_id, project_id, path, created_at DESC, id DESC;
