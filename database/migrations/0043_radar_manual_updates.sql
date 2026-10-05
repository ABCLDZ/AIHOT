CREATE TABLE radar_update_runs (
  id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  actor text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','running','completed','partial','failed')),
  stage text NOT NULL DEFAULT '准备更新',
  detail jsonb NOT NULL DEFAULT '{}',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX radar_one_active_run ON radar_update_runs ((true)) WHERE state IN ('pending','running');
CREATE TABLE article_radar_assessments (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  original_title text NOT NULL,
  prompt_version text NOT NULL,
  context_hash text NOT NULL,
  output jsonb NOT NULL,
  model text NOT NULL,
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(article_id,revision,prompt_version,context_hash)
);
