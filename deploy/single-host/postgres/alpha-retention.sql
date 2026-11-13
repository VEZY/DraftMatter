-- Run after application migrations, before opening the alpha (and after upgrades).
-- Leave a day for scheduled physical cleanup within the public 30-day ceiling.
BEGIN;
ALTER TABLE draftmatter_workspace_policies
  ALTER COLUMN backup_max_age_days SET DEFAULT 29;
UPDATE draftmatter_workspace_policies
  SET backup_max_age_days = 29
  WHERE backup_max_age_days > 29;
COMMIT;
