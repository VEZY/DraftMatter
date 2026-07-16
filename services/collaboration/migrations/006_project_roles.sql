CREATE TABLE draftmatter_project_roles (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
  assigned_by TEXT NOT NULL REFERENCES draftmatter_users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, project_id, user_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES draftmatter_projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES draftmatter_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX draftmatter_project_roles_user
  ON draftmatter_project_roles(workspace_id, user_id, project_id);
