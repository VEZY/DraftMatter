CREATE TABLE draftmatter_notification_deliveries (
  notification_id TEXT PRIMARY KEY REFERENCES draftmatter_notifications(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  leased_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  discarded_at TIMESTAMPTZ,
  last_error TEXT,
  CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  CHECK (NOT (delivered_at IS NOT NULL AND discarded_at IS NOT NULL))
);

CREATE INDEX draftmatter_notification_delivery_due
  ON draftmatter_notification_deliveries(next_attempt_at, notification_id)
  WHERE delivered_at IS NULL AND discarded_at IS NULL;
