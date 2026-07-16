CREATE TABLE draftmatter_review_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES draftmatter_users(id),
  reviewer_id TEXT NOT NULL REFERENCES draftmatter_users(id),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'changes-requested', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMPTZ,
  decided_by TEXT REFERENCES draftmatter_users(id),
  decision_note TEXT,
  cancelled_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES draftmatter_projects(workspace_id, id) ON DELETE CASCADE,
  CHECK (requested_by <> reviewer_id),
  CHECK (char_length(message) BETWEEN 1 AND 1000),
  CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000)
);

CREATE INDEX draftmatter_review_request_project_time
  ON draftmatter_review_requests(workspace_id, project_id, created_at DESC, id DESC);

CREATE INDEX draftmatter_review_request_reviewer_open
  ON draftmatter_review_requests(reviewer_id, created_at DESC, id DESC)
  WHERE status = 'open';

CREATE UNIQUE INDEX draftmatter_one_open_review_request
  ON draftmatter_review_requests(workspace_id, project_id, requested_by, reviewer_id)
  WHERE status = 'open';

CREATE TABLE draftmatter_notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES draftmatter_users(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES draftmatter_users(id),
  review_request_id TEXT NOT NULL REFERENCES draftmatter_review_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('review-requested', 'review-approved', 'review-changes-requested', 'review-cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES draftmatter_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX draftmatter_notification_user_unread
  ON draftmatter_notifications(user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
