-- The hosted closed alpha commits to a maximum of thirty days for technical
-- backup copies. Project state and user-created recovery history remain active
-- project data; their lifetime ends through the workspace deletion workflow.
ALTER TABLE draftmatter_workspace_policies
  ALTER COLUMN backup_max_age_days SET DEFAULT 30;

UPDATE draftmatter_workspace_policies
  SET backup_max_age_days = 30
  WHERE backup_max_age_days > 30;

ALTER TABLE draftmatter_workspace_policies
  ADD CONSTRAINT draftmatter_alpha_backup_max_age
  CHECK (backup_max_age_days <= 30);
