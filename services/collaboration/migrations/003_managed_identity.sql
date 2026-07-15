ALTER TABLE draftmatter_users
  ADD COLUMN identity_issuer TEXT,
  ADD COLUMN identity_subject TEXT;

CREATE UNIQUE INDEX draftmatter_identity_subject
  ON draftmatter_users(identity_issuer, identity_subject)
  WHERE identity_issuer IS NOT NULL AND identity_subject IS NOT NULL;
