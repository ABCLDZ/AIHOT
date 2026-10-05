-- Title translations for the private topic workbench. Never imply publication or selection.
CREATE TABLE article_title_translations (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  original_title text NOT NULL,
  translated_title text NOT NULL CHECK (length(translated_title) > 0),
  method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, revision)
);
