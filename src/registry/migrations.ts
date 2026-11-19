/**
 * The registry's database schema as ordered, append-only migrations. They are plain SQL kept in
 * code (not in files) so the bundled image carries them. Never edit or reorder a migration that
 * has shipped; add a new one. Names are unqualified: the connection's `search_path` decides the
 * schema (the tests give every instance its own).
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "app_registry",
    sql: `
CREATE TABLE apps (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  purpose            text NOT NULL,
  -- The owner: a Weldall user id (the verified token's sub), and the email address the owner's
  -- last token carried (null until the owner used this Git app, for an app an administrator
  -- registered for them).
  owner_subject      text NOT NULL,
  owner_email        text,
  -- Host-side repository in this instance's organisation; names in the host's spelling.
  repository_owner   text NOT NULL,
  repository_name    text NOT NULL,
  -- Stable host id that survives renames, when the host has one.
  repository_id      text,
  repository_web_url text,
  -- Branch the git proxy never accepts pushes to.
  default_branch     text NOT NULL,
  -- Template the app started from; null for a registered existing repository. The template
  -- commit stays null until creation finished: until then the app is not ready.
  template           text,
  template_commit    text,
  preview_url        text,
  live_url           text,
  -- Weldall user id of whoever registered the entry (the owner, or an administrator).
  registered_by      text NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  -- Moved only by the owner's confirmation, never by a publish. Past it the app is flagged.
  expires_at         timestamptz NOT NULL,
  confirmed_at       timestamptz,
  confirmed_by       text,
  CONSTRAINT apps_template_commit_needs_template CHECK (template IS NOT NULL OR template_commit IS NULL),
  CONSTRAINT apps_confirmation_complete CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL))
);
-- Git hosts compare repository names case-insensitively.
CREATE UNIQUE INDEX apps_repository_key ON apps (lower(repository_owner), lower(repository_name));
CREATE UNIQUE INDEX apps_repository_id_key ON apps (repository_id) WHERE repository_id IS NOT NULL;
CREATE INDEX apps_owner_idx ON apps (owner_subject, expires_at, id);
CREATE INDEX apps_expires_idx ON apps (expires_at, id);
CREATE INDEX apps_created_idx ON apps (created_at, id);
`,
  },
];
