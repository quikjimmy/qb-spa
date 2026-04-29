import Database from 'better-sqlite3'
import path from 'path'

const DATA_DIR = process.env['DATA_DIR'] || process.cwd()
const dbPath = path.resolve(DATA_DIR, 'portal.db')
const db = new Database(dbPath)

db.pragma('journal_mode = WAL')

// --- Users ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    invite_token TEXT UNIQUE,
    invite_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// Idempotent additive migration: reset_token + reset_expires_at.
// SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so guard via info query.
{
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('reset_token')) db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`)
  if (!names.has('reset_expires_at')) db.exec(`ALTER TABLE users ADD COLUMN reset_expires_at TEXT`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL`)
}

// --- Roles ---
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_system INTEGER NOT NULL DEFAULT 0,
    qb_role_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// --- User <-> Role (many-to-many) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  )
`)

// --- Permissions ---
// resource_type: 'view' | 'table' | 'field'
// resource_id:
//   view  → route name, e.g. 'dashboard', 'projects', 'admin'
//   table → QB table ID, e.g. 'br9kwm8na'
//   field → 'tableId.fieldId', e.g. 'br9kwm8na.145'
// can_read / can_write: 0 or 1
db.exec(`
  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('view', 'table', 'field')),
    resource_id TEXT NOT NULL,
    can_read INTEGER NOT NULL DEFAULT 1,
    can_write INTEGER NOT NULL DEFAULT 0,
    UNIQUE (role_id, resource_type, resource_id)
  )
`)

// --- Record Filters ---
// Per role + table: which QB field must match the user's email
// When a user with this role queries this table, the proxy injects:
//   {'<qb_field_id>'.EX.'<user email>'}
// admin role is exempt (sees all records)
db.exec(`
  CREATE TABLE IF NOT EXISTS record_filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    table_id TEXT NOT NULL,
    qb_email_field_id INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (role_id, table_id)
  )
`)

// --- Activity Feed ---
// Feed items are ingested from QB and stored locally for fast retrieval
db.exec(`
  CREATE TABLE IF NOT EXISTS feed_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qb_source TEXT NOT NULL,
    qb_record_id INTEGER,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    actor_name TEXT,
    actor_email TEXT,
    project_id INTEGER,
    project_name TEXT,
    metadata TEXT,
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (qb_source, qb_record_id, event_type, occurred_at)
  )
`)

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_feed_occurred ON feed_items(occurred_at DESC)
`)

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_feed_actor ON feed_items(actor_email)
`)

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_feed_project ON feed_items(project_id)
`)

// --- Media Attachments ---
db.exec(`
  CREATE TABLE IF NOT EXISTS media_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    width INTEGER,
    height INTEGER,
    duration_sec REAL,
    thumb_file_name TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_media_feed ON media_attachments(feed_item_id)`)

// --- Comments (portal-native, not in QB) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_comments_feed ON comments(feed_item_id)
`)

// --- Reactions ---
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (feed_item_id, user_id, emoji)
  )
`)

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reactions_feed ON reactions(feed_item_id)
`)

// --- Favorites ---
db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, project_id)
  )
`)

// --- Notifications ---
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC)
`)

// --- Agent runs (execution history) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    duration_ms INTEGER,
    projects_scanned INTEGER DEFAULT 0,
    projects_classified INTEGER DEFAULT 0,
    projects_skipped INTEGER DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_cents INTEGER DEFAULT 0,
    model TEXT,
    error TEXT
  )
`)

// Additive: prompt + output for user-triggered runs (test iterations).
// Guarded via PRAGMA to be idempotent on upgraded DBs.
{
  const cols = db.prepare(`PRAGMA table_info(agent_runs)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('prompt')) db.exec(`ALTER TABLE agent_runs ADD COLUMN prompt TEXT`)
  if (!names.has('output')) db.exec(`ALTER TABLE agent_runs ADD COLUMN output TEXT`)
  if (!names.has('user_id')) db.exec(`ALTER TABLE agent_runs ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`)
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent, started_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, started_at DESC)`)

// --- Per-user LLM usage ledger (chatbot + future per-user features) ---
// agent_runs is for scheduled/system agent work; this table is for any LLM
// call attributed to a specific user (chatbot, ad-hoc actions). Separate so
// agent_runs stays focused on agent execution metadata.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    feature TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    used_own_key INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_llm_usage_user ON user_llm_usage(user_id, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_llm_usage_month ON user_llm_usage(user_id, created_at)`)

// --- Chat threads + messages (per-user persistent conversations) ---
// project_id is the optional in-session project context. NULL = general chat.
// project_id is intentionally not a FK — projects live in QuickBase, not this DB.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    project_id INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id, archived, last_message_at DESC)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    used_own_key INTEGER,
    tool_calls_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at)`)

// Per-thread model + provider preference (sticks across messages once set via /model)
{
  const cols = db.prepare(`PRAGMA table_info(chat_threads)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('preferred_provider')) db.exec(`ALTER TABLE chat_threads ADD COLUMN preferred_provider TEXT`)
  if (!names.has('preferred_model')) db.exec(`ALTER TABLE chat_threads ADD COLUMN preferred_model TEXT`)
}

// --- Provider rate-limit snapshots (per user, per provider) ---
// Captured from API response headers on each call. Lets the chat UI show
// "you have N tokens / requests left in this window" without polling.
// Note: providers expose short-window limits (per-minute/hour), not monthly
// spend — that's still dashboard-only. App-level monthly cap lives in user_budgets.
db.exec(`
  CREATE TABLE IF NOT EXISTS provider_rate_snapshots (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    tokens_remaining INTEGER,
    tokens_limit INTEGER,
    requests_remaining INTEGER,
    requests_limit INTEGER,
    reset_at TEXT,
    used_own_key INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, provider)
  )
`)

// --- Chat Spaces (per-user, per-QB-project workspaces holding many threads) ---
// Mirrors ChatGPT/Claude "Projects": each Space pins a QB project's context.
// One Space per (user, qb_project_id) so opening chat for the same project
// always lands the user back in the same workspace.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    system_instructions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  )
`)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_spaces_user_project ON chat_spaces(user_id, project_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_spaces_recent ON chat_spaces(user_id, last_used_at DESC)`)

// Bind chat_threads to a space. Nullable: NULL = general (project-less) thread.
{
  const cols = db.prepare(`PRAGMA table_info(chat_threads)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('space_id')) db.exec(`ALTER TABLE chat_threads ADD COLUMN space_id INTEGER REFERENCES chat_spaces(id) ON DELETE SET NULL`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_threads_space ON chat_threads(space_id, last_message_at DESC)`)

// One-shot migration: existing project-attached threads (project_id set, no space_id)
// get promoted into auto-spaces named after the project's customer.
{
  const orphans = db.prepare(
    `SELECT t.id, t.user_id, t.project_id, p.customer_name
       FROM chat_threads t
       LEFT JOIN project_cache p ON p.record_id = t.project_id
      WHERE t.space_id IS NULL AND t.project_id IS NOT NULL`
  ).all() as Array<{ id: number; user_id: number; project_id: number; customer_name: string | null }>

  const findSpace = db.prepare(`SELECT id FROM chat_spaces WHERE user_id = ? AND project_id = ?`)
  const insertSpace = db.prepare(`INSERT INTO chat_spaces (user_id, project_id, name) VALUES (?, ?, ?)`)
  const bind = db.prepare(`UPDATE chat_threads SET space_id = ? WHERE id = ?`)

  for (const t of orphans) {
    let spaceId: number
    const existing = findSpace.get(t.user_id, t.project_id) as { id: number } | undefined
    if (existing) {
      spaceId = existing.id
    } else {
      const r = insertSpace.run(t.user_id, t.project_id, t.customer_name || `Project ${t.project_id}`)
      spaceId = Number(r.lastInsertRowid)
    }
    bind.run(spaceId, t.id)
  }
}

// --- Agent outputs (latest classification per project+agent) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    payload_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (agent, project_id)
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_outputs_project ON agent_outputs(project_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent, generated_at DESC)`)

// --- App-level feedback (floating widget → admin triage queue) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS app_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    path TEXT NOT NULL,
    category TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    triaged_by INTEGER REFERENCES users(id),
    triaged_at TEXT,
    triage_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_app_feedback_status ON app_feedback(status, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_app_feedback_user ON app_feedback(user_id)`)

// Add cluster_id link from feedback to its cluster (idempotent)
const feedbackCols = db.prepare(`PRAGMA table_info(app_feedback)`).all() as Array<{ name: string }>
if (!feedbackCols.some(c => c.name === 'cluster_id')) {
  db.exec(`ALTER TABLE app_feedback ADD COLUMN cluster_id INTEGER`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_app_feedback_cluster ON app_feedback(cluster_id)`)

// --- Feedback clusters: similar requests grouped by the triage agent ---
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    theme TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    item_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT,
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_clusters_status ON feedback_clusters(status, last_seen DESC)`)

// --- Improvement proposals: agent-drafted recommendation per cluster, awaiting human approval ---
db.exec(`
  CREATE TABLE IF NOT EXISTS improvement_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id INTEGER NOT NULL REFERENCES feedback_clusters(id) ON DELETE CASCADE,
    scope_md TEXT NOT NULL,
    files_touched_json TEXT NOT NULL DEFAULT '[]',
    effort_estimate TEXT,
    risk_notes TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting_approval',
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    rejection_reason TEXT,
    target_release TEXT,
    triage_run_id INTEGER,
    model TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_improvement_proposals_status ON improvement_proposals(status, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_improvement_proposals_cluster ON improvement_proposals(cluster_id)`)

// --- Triage runs: audit trail of when the feedback agent ran and what it found ---
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_triage_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    feedback_considered INTEGER NOT NULL DEFAULT 0,
    clusters_touched INTEGER NOT NULL DEFAULT 0,
    proposals_drafted INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    triggered_by INTEGER REFERENCES users(id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_triage_runs_started ON feedback_triage_runs(started_at DESC)`)

// --- User-created agents (bones; execution not wired yet) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS user_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    llm TEXT NOT NULL,
    monthly_token_cap INTEGER NOT NULL DEFAULT 50000,
    tokens_used_month INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'ollama-free',
    status TEXT NOT NULL DEFAULT 'draft',
    department TEXT,
    submission_note TEXT,
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents(user_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_agents_status ON user_agents(status, created_at DESC)`)

// --- Per-user aggregate budget (authoritative cap across all their agents) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS user_budgets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    monthly_token_cap INTEGER NOT NULL DEFAULT 50000,
    tokens_used_month INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'ollama-free',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
{
  const cols = db.prepare(`PRAGMA table_info(user_budgets)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  // monthly_cap_cents = USD cap on platform-key spend (null = no cap set, fall back to global env cap)
  if (!names.has('monthly_cap_cents')) db.exec(`ALTER TABLE user_budgets ADD COLUMN monthly_cap_cents INTEGER`)
  // 1 = BYOK calls don't count against the cap (encourages users to bring their own key)
  if (!names.has('byok_bypasses_cap')) db.exec(`ALTER TABLE user_budgets ADD COLUMN byok_bypasses_cap INTEGER NOT NULL DEFAULT 1`)
}

// --- Per-user Ollama connection (encrypted at rest) ---
// Legacy single-provider table. New BYOK flow uses user_provider_keys (below);
// this table is migrated into user_provider_keys at boot and then no longer written to.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_ollama_config (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    api_key_encrypted TEXT,
    base_url TEXT NOT NULL DEFAULT 'https://ollama.com',
    last_tested_at TEXT,
    last_test_ok INTEGER,
    last_test_error TEXT,
    last_test_models_count INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// --- Generic per-user provider keys (multi-provider, multi-key) ---
// Replaces user_ollama_config. Supports anthropic / openai / ollama, with
// multiple labelled keys per provider and one default per (user, provider).
db.exec(`
  CREATE TABLE IF NOT EXISTS user_provider_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label TEXT,
    api_key_encrypted TEXT NOT NULL,
    base_url TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    last_tested_at TEXT,
    last_test_ok INTEGER,
    last_test_error TEXT,
    last_test_models_count INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_provider_keys_user ON user_provider_keys(user_id, provider)`)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_provider_default ON user_provider_keys(user_id, provider) WHERE is_default = 1`)

// One-shot migration: copy any existing user_ollama_config rows into
// user_provider_keys as the user's default ollama key. Only runs if the
// destination has no ollama rows for that user yet, so it's idempotent.
{
  const legacyRows = db.prepare(`SELECT user_id, api_key_encrypted, base_url, last_tested_at, last_test_ok, last_test_error, last_test_models_count, updated_at FROM user_ollama_config WHERE api_key_encrypted IS NOT NULL`).all() as Array<{
    user_id: number; api_key_encrypted: string; base_url: string;
    last_tested_at: string | null; last_test_ok: number | null;
    last_test_error: string | null; last_test_models_count: number | null;
    updated_at: string;
  }>
  const checkExisting = db.prepare(`SELECT 1 FROM user_provider_keys WHERE user_id = ? AND provider = 'ollama' LIMIT 1`)
  const insert = db.prepare(`INSERT INTO user_provider_keys (user_id, provider, label, api_key_encrypted, base_url, is_default, last_tested_at, last_test_ok, last_test_error, last_test_models_count, created_at, updated_at) VALUES (?, 'ollama', 'default', ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
  for (const r of legacyRows) {
    if (checkExisting.get(r.user_id)) continue
    insert.run(r.user_id, r.api_key_encrypted, r.base_url, r.last_tested_at, r.last_test_ok, r.last_test_error, r.last_test_models_count, r.updated_at, r.updated_at)
  }
}

// --- Alternate emails per user (not used for login) ---
// Primary login email stays on `users.email`. This table holds additional
// addresses used for cross-system matching (Dialpad, QuickBase, Slack, etc).
// `system` scopes the alias: empty string = matches any system, or a tag like
// 'dialpad' / 'quickbase' / 'slack' limits the alias to one system.
// UNIQUE(user_id, LOWER(email), system) prevents dupes per user+system but
// allows the same email to be tagged under multiple systems with separate rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    system TEXT NOT NULL DEFAULT '',
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_unique ON user_emails(user_id, LOWER(email), system)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_emails_lookup ON user_emails(LOWER(email))`)

// Union view combining primary + alternate emails. Matching across systems
// selects from this view so alias logic lives in one place.
//   system = '' for the primary login email (matches any system)
//   system = tag for an alternate scoped to that system
//   is_primary = 1 only for the row from users.email
db.exec(`DROP VIEW IF EXISTS user_email_lookup`)
db.exec(`
  CREATE VIEW user_email_lookup AS
  SELECT id AS user_id, LOWER(TRIM(email)) AS email, '' AS system, name AS user_name, 1 AS is_primary
  FROM users WHERE email IS NOT NULL AND email != ''
  UNION ALL
  SELECT ue.user_id, LOWER(TRIM(ue.email)) AS email, COALESCE(ue.system, '') AS system,
         u.name AS user_name, 0 AS is_primary
  FROM user_emails ue
  JOIN users u ON u.id = ue.user_id
  WHERE ue.email IS NOT NULL AND ue.email != ''
`)

// --- Dialpad integration (singleton config) ---
// Dialpad is a company-wide integration, so one encrypted API key + office_id
// lives here (not per-user). API key encrypted at rest with ENCRYPTION_KEY.
// webhook_secret_encrypted is the HMAC secret Dialpad signs webhook JWTs with.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    api_key_encrypted TEXT,
    office_id TEXT,
    last_tested_at TEXT,
    last_test_ok INTEGER,
    last_test_error TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
// Ensure the singleton row exists so UPDATEs always have a target.
db.prepare(`INSERT OR IGNORE INTO dialpad_config (id) VALUES (1)`).run()
// Additive migration: webhook_secret_encrypted.
{
  const cols = db.prepare(`PRAGMA table_info(dialpad_config)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('webhook_secret_encrypted')) db.exec(`ALTER TABLE dialpad_config ADD COLUMN webhook_secret_encrypted TEXT`)
  // Subscription bookkeeping — stored so we can show status + revoke cleanly.
  if (!names.has('webhook_id')) db.exec(`ALTER TABLE dialpad_config ADD COLUMN webhook_id TEXT`)
  if (!names.has('call_subscription_id')) db.exec(`ALTER TABLE dialpad_config ADD COLUMN call_subscription_id TEXT`)
  if (!names.has('sms_subscription_id')) db.exec(`ALTER TABLE dialpad_config ADD COLUMN sms_subscription_id TEXT`)
  // Last error per sub kind so admins can see why activation partially failed.
  if (!names.has('call_subscription_error')) db.exec(`ALTER TABLE dialpad_config ADD COLUMN call_subscription_error TEXT`)
  if (!names.has('sms_subscription_error')) db.exec(`ALTER TABLE dialpad_config ADD COLUMN sms_subscription_error TEXT`)
}

// Webhook-delivered events. Stored raw for forensics + displayed live via SSE.
// We keep a narrow set of hoisted columns for indexable filters; the full JWT
// payload is preserved in raw_json so new fields don't require schema changes.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_kind TEXT NOT NULL,
    event_state TEXT,
    call_id TEXT,
    user_email TEXT,
    user_name TEXT,
    external_number TEXT,
    direction TEXT,
    raw_json TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_events_received ON dialpad_events(received_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_events_email ON dialpad_events(user_email, received_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_events_call ON dialpad_events(call_id)`)

// Additive migration — text_body caches the SMS body once we've extracted
// it from the webhook payload OR backfilled it via Dialpad's /sms/{id}
// API. Outbound SMS status webhooks don't include the body, so we have to
// look it up. Caching here keeps the thread fast on subsequent loads.
{
  const cols = db.prepare(`PRAGMA table_info(dialpad_events)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('text_body')) db.exec(`ALTER TABLE dialpad_events ADD COLUMN text_body TEXT`)
  if (!names.has('text_body_fetched_at')) db.exec(`ALTER TABLE dialpad_events ADD COLUMN text_body_fetched_at TEXT`)
}

// Diagnostic log — every single POST that hits /api/webhooks/dialpad* is
// recorded BEFORE signature verification, so we can tell "nothing arrived"
// apart from "arrived but was rejected". Kept small (short body preview)
// and capped by the caller to 500 rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    method TEXT NOT NULL,
    content_type TEXT,
    body_preview TEXT,
    signature_ok INTEGER,
    inferred_kind TEXT,
    status_code INTEGER,
    error TEXT,
    stored_event_id INTEGER,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_deliveries_recv ON dialpad_webhook_deliveries(received_at DESC)`)

// Per-user per-day per-leaf-bucket call aggregates. One row per
// (user_email, call_date, bucket). Leaf bucket values are classified at ingest
// time — rollups (inbound_total, outbound_total, answered, etc.) are computed
// in SQL from these leaves, so adding a new drill-down only needs a query
// change, not a re-ingest.
//
// Leaf buckets (match the Comms Hub drill-down tree):
//   inbound:  in_answered, in_missed, in_abandoned, in_voicemail,
//             in_transfer_unanswered, in_callback_requested
//   outbound: out_connected, out_cancelled, out_callback_attempt
//   other:    unclassified / fallback
//
// Rebuilt from a Dialpad records-export CSV on each refresh — safe to DELETE
// the window and re-INSERT in a transaction.
{
  // Prior shape keyed on `direction` rather than `bucket`. Drop it so the
  // CREATE below produces the new shape. Data is a cache — fully rebuildable
  // from Dialpad, so discarding is safe.
  const cols = db.prepare(`PRAGMA table_info(dialpad_call_daily)`).all() as Array<{ name: string }>
  const has = new Set(cols.map(c => c.name))
  if (cols.length > 0 && !has.has('bucket')) {
    db.exec(`DROP TABLE dialpad_call_daily`)
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_call_daily (
    user_email TEXT NOT NULL,
    user_name TEXT,
    call_date TEXT NOT NULL,
    bucket TEXT NOT NULL,
    call_count INTEGER NOT NULL DEFAULT 0,
    talk_time_sec INTEGER NOT NULL DEFAULT 0,
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_email, call_date, bucket)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_daily_email ON dialpad_call_daily(user_email, call_date DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_daily_date ON dialpad_call_daily(call_date DESC)`)

// Per-call records. Mirrors the rows from Dialpad's records export — one row
// per call leg per user — and drives the Call Activity Feed. We keep only the
// columns the UI needs so the table stays lean; bucket is computed at ingest
// time (same classifier used for dialpad_call_daily) so the feed can filter
// by leaf without rerunning the logic on every request.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_call_records (
    call_id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    user_name TEXT,
    direction TEXT NOT NULL,
    bucket TEXT NOT NULL,
    external_number TEXT,
    started_at TEXT NOT NULL,
    connected_at TEXT,
    ended_at TEXT,
    talk_time_sec INTEGER NOT NULL DEFAULT 0,
    ring_time_sec INTEGER NOT NULL DEFAULT 0,
    was_voicemail INTEGER NOT NULL DEFAULT 0,
    was_recorded INTEGER NOT NULL DEFAULT 0,
    was_transfer INTEGER NOT NULL DEFAULT 0,
    entry_point_target_kind TEXT,
    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
// Additive migration — existing DBs have the narrower shape.
{
  const cols = db.prepare(`PRAGMA table_info(dialpad_call_records)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('was_recorded')) db.exec(`ALTER TABLE dialpad_call_records ADD COLUMN was_recorded INTEGER NOT NULL DEFAULT 0`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_rec_email_started ON dialpad_call_records(user_email, started_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_rec_started ON dialpad_call_records(started_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_rec_bucket ON dialpad_call_records(bucket, started_at DESC)`)

// Per-user inbox read state. "Unread" = absence of a row here for a given
// (user_id, call_id). Mark-as-read inserts; no delete on "un-read" (we can
// add that later if needed). Kept separate from dialpad_call_records so a
// cache rebuild doesn't blow away read state.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_inbox_reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, call_id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_inbox_read_user ON dialpad_inbox_reads(user_id, read_at DESC)`)

// Per-user read state for SMS messages. Keyed on dialpad_events.id so each
// webhook-delivered SMS row can be marked read independently. Separate from
// dialpad_inbox_reads (which keys on call_id TEXT) to avoid pretending we
// have a polymorphic PK on a text column.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_sms_reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, event_id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_sms_read_user ON dialpad_sms_reads(user_id, read_at DESC)`)

// Per-user per-day SMS aggregates. Directions kept tight: 'incoming' | 'outgoing'.
// SMS may not be supported on every Dialpad plan — refresh gracefully skips if
// the stat_type is rejected.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_sms_daily (
    user_email TEXT NOT NULL,
    user_name TEXT,
    sms_date TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'unknown')),
    message_count INTEGER NOT NULL DEFAULT 0,
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_email, sms_date, direction)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_sms_email ON dialpad_sms_daily(user_email, sms_date DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_sms_date ON dialpad_sms_daily(sms_date DESC)`)

// Records the last completed sync window so the dashboard can show freshness.
db.exec(`
  CREATE TABLE IF NOT EXISTS dialpad_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_type TEXT NOT NULL,
    days_ago_start INTEGER NOT NULL,
    days_ago_end INTEGER NOT NULL,
    target_type TEXT,
    target_id TEXT,
    request_id TEXT,
    status TEXT NOT NULL,
    rows_ingested INTEGER DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_dp_sync_log_started ON dialpad_sync_log(started_at DESC)`)

// --- Departments ---
db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// --- User <-> Department (many-to-many) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS user_departments (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, department_id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_departments_user ON user_departments(user_id)`)

// --- Production agent org model ---
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_roles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    objective TEXT NOT NULL,
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('singleton', 'manager', 'worker')),
    parent_role_id INTEGER REFERENCES agent_roles(id) ON DELETE SET NULL,
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    department TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'retired')),
    llm TEXT NOT NULL,
    monthly_token_cap INTEGER NOT NULL DEFAULT 0,
    tokens_used_month INTEGER NOT NULL DEFAULT 0,
    approval_required INTEGER NOT NULL DEFAULT 1,
    is_lab_only INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_roles_parent ON agent_roles(parent_role_id)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_roles_status ON agent_roles(status, department)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_goals (
    id INTEGER PRIMARY KEY,
    agent_role_id INTEGER NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    success_metric TEXT,
    priority INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_goals_role ON agent_goals(agent_role_id, status, priority)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_role_tasks (
    id INTEGER PRIMARY KEY,
    agent_role_id INTEGER NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK (task_type IN ('summary', 'outreach', 'classification', 'escalation', 'digest', 'custom')),
    runtime TEXT NOT NULL DEFAULT 'builtin' CHECK (runtime IN ('builtin', 'openclaw', 'nemoclaw')),
    instructions TEXT NOT NULL,
    input_template_json TEXT,
    output_schema_json TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
{
  const cols = db.prepare(`PRAGMA table_info(agent_role_tasks)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('runtime')) {
    try { db.exec(`ALTER TABLE agent_role_tasks ADD COLUMN runtime TEXT NOT NULL DEFAULT 'builtin'`) } catch { /* already exists */ }
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_role_tasks_role ON agent_role_tasks(agent_role_id, enabled)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_task_drafts (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES agent_role_tasks(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    draft_json TEXT NOT NULL,
    compliance_review_json TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'requested', 'approved', 'rejected')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id, user_id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_task_drafts_task ON agent_task_drafts(task_id, updated_at DESC)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_task_draft_messages (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES agent_role_tasks(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    patch_json TEXT,
    compliance_review_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_task_draft_messages_task ON agent_task_draft_messages(task_id, user_id, created_at)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_task_schedules (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES agent_role_tasks(id) ON DELETE CASCADE,
    cron_expr TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_task_schedules_task ON agent_task_schedules(task_id, enabled)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_permissions (
    id INTEGER PRIMARY KEY,
    agent_role_id INTEGER NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    action TEXT NOT NULL,
    constraints_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_permissions_unique ON agent_permissions(agent_role_id, resource, action)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_task_runs (
    id INTEGER PRIMARY KEY,
    agent_role_id INTEGER NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES agent_role_tasks(id) ON DELETE SET NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'cron', 'delegated', 'api')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'approval_pending')),
    payload_json TEXT,
    result_json TEXT,
    error TEXT,
    scheduled_for TEXT,
    started_at TEXT,
    finished_at TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    parent_run_id INTEGER REFERENCES agent_task_runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_task_runs_role ON agent_task_runs(agent_role_id, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_task_runs_status ON agent_task_runs(status, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_task_runs_parent ON agent_task_runs(parent_run_id)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_approvals (
    id INTEGER PRIMARY KEY,
    task_run_id INTEGER NOT NULL REFERENCES agent_task_runs(id) ON DELETE CASCADE,
    requested_action TEXT NOT NULL,
    requested_payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    review_note TEXT,
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_approvals_status ON agent_approvals(status, requested_at DESC)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_delivery_configs (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES agent_role_tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    audience_type TEXT NOT NULL DEFAULT 'department' CHECK (audience_type IN ('department', 'user', 'manual')),
    audience_value TEXT,
    channel TEXT NOT NULL DEFAULT 'agent_ops_inbox' CHECK (channel IN ('agent_ops_inbox', 'slack', 'email')),
    enabled INTEGER NOT NULL DEFAULT 1,
    approval_required INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_delivery_configs_task ON agent_delivery_configs(task_id, enabled)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_delivery_recipients (
    id INTEGER PRIMARY KEY,
    delivery_config_id INTEGER NOT NULL REFERENCES agent_delivery_configs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    qb_coordinator_name TEXT,
    qb_coordinator_email TEXT,
    channel TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(delivery_config_id, user_id)
  )
`)
{
  const cols = db.prepare(`PRAGMA table_info(agent_delivery_recipients)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('qb_coordinator_email')) db.exec(`ALTER TABLE agent_delivery_recipients ADD COLUMN qb_coordinator_email TEXT`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_delivery_recipients_user ON agent_delivery_recipients(user_id, enabled)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_delivery_items (
    id INTEGER PRIMARY KEY,
    delivery_config_id INTEGER REFERENCES agent_delivery_configs(id) ON DELETE SET NULL,
    task_run_id INTEGER REFERENCES agent_task_runs(id) ON DELETE SET NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'agent_ops_inbox',
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
    body_json TEXT,
    error TEXT,
    read_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'dismissed', 'commented')),
    review_comment TEXT,
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
{
  const cols = db.prepare(`PRAGMA table_info(agent_delivery_items)`).all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has('deleted_at')) {
    try { db.exec(`ALTER TABLE agent_delivery_items ADD COLUMN deleted_at TEXT`) } catch { /* already exists */ }
  }
  if (!names.has('review_status')) {
    try { db.exec(`ALTER TABLE agent_delivery_items ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'`) } catch { /* already exists */ }
  }
  if (!names.has('review_comment')) {
    try { db.exec(`ALTER TABLE agent_delivery_items ADD COLUMN review_comment TEXT`) } catch { /* already exists */ }
  }
  if (!names.has('reviewed_by_user_id')) {
    try { db.exec(`ALTER TABLE agent_delivery_items ADD COLUMN reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`) } catch { /* already exists */ }
  }
  if (!names.has('reviewed_at')) {
    try { db.exec(`ALTER TABLE agent_delivery_items ADD COLUMN reviewed_at TEXT`) } catch { /* already exists */ }
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_delivery_items_user ON agent_delivery_items(user_id, read_at, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_delivery_items_run ON agent_delivery_items(task_run_id)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_work_items (
    id INTEGER PRIMARY KEY,
    source_delivery_item_id INTEGER REFERENCES agent_delivery_items(id) ON DELETE SET NULL,
    task_run_id INTEGER REFERENCES agent_task_runs(id) ON DELETE SET NULL,
    project_rid TEXT,
    project_name TEXT,
    title TEXT NOT NULL,
    detail TEXT,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed')),
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_agent_role_id INTEGER REFERENCES agent_roles(id) ON DELETE SET NULL,
    action_payload_json TEXT,
    due_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_work_items_assigned ON agent_work_items(assigned_user_id, status, updated_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_work_items_delivery ON agent_work_items(source_delivery_item_id)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_action_feedback (
    id INTEGER PRIMARY KEY,
    source_delivery_item_id INTEGER REFERENCES agent_delivery_items(id) ON DELETE SET NULL,
    task_run_id INTEGER REFERENCES agent_task_runs(id) ON DELETE SET NULL,
    project_rid TEXT,
    category TEXT,
    action_key TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'dismissed', 'commented')),
    comment TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_action_feedback_key ON agent_action_feedback(action_key, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_action_feedback_delivery ON agent_action_feedback(source_delivery_item_id, created_at DESC)`)

// --- Seed starter departments (idempotent) ---
const seedDept = db.prepare(`INSERT OR IGNORE INTO departments (name, description) VALUES (?, ?)`)
const seedDeptTxn = db.transaction(() => {
  seedDept.run('PC', 'Project Coordinators')
  seedDept.run('INSPX', 'Inspections')
  seedDept.run('PTO', 'Permit-to-operate / utility interconnect')
  seedDept.run('Operations', 'General ops / admin')
  seedDept.run('Engineering', 'Design & engineering')
  seedDept.run('Sales', 'Sales & rep support')
})
seedDeptTxn()

// --- Seed default roles if they don't exist ---
const seedRoles = db.prepare(`
  INSERT OR IGNORE INTO roles (name, description, is_system) VALUES (?, ?, ?)
`)
const seedTransaction = db.transaction(() => {
  seedRoles.run('admin', 'Full access to all portal features and settings', 1)
  seedRoles.run('Internal Ops', 'Internal operations team member', 1)
  seedRoles.run('Customer Support', 'Customer support and service workflows', 1)
  seedRoles.run('Field Ops', 'Field operations team member', 1)
  seedRoles.run('Customer', 'Customer portal access', 1)
  seedRoles.run('Sales Manager', 'Sales management access', 1)
  seedRoles.run('Sales Rep', 'Sales representative access', 1)

  // Legacy names kept for compatibility with older users and permissions.
  seedRoles.run('customer', 'Legacy customer role', 1)
  seedRoles.run('lender', 'Legacy lender role', 1)
  seedRoles.run('crew', 'Legacy field crew role', 1)
})
seedTransaction()

const upsertAgentRole = db.prepare(`
  INSERT INTO agent_roles (name, slug, description, objective, execution_mode, parent_role_id, department, status, llm, monthly_token_cap, approval_required, is_lab_only, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(slug) DO UPDATE SET
    name=excluded.name,
    description=excluded.description,
    objective=excluded.objective,
    execution_mode=excluded.execution_mode,
    parent_role_id=excluded.parent_role_id,
    department=excluded.department,
    status=excluded.status,
    llm=excluded.llm,
    monthly_token_cap=excluded.monthly_token_cap,
    approval_required=excluded.approval_required,
    is_lab_only=excluded.is_lab_only,
    updated_at=CURRENT_TIMESTAMP
`)
const roleIdBySlug = db.prepare(`SELECT id FROM agent_roles WHERE slug = ?`)
const insertGoalIfMissing = db.prepare(`
  INSERT INTO agent_goals (agent_role_id, title, description, success_metric, priority, status, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_goals WHERE agent_role_id = ? AND title = ?
  )
`)
const insertTaskIfMissing = db.prepare(`
  INSERT INTO agent_role_tasks (agent_role_id, name, task_type, instructions, input_template_json, output_schema_json, enabled, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_role_tasks WHERE agent_role_id = ? AND name = ?
  )
`)
const taskIdByRoleAndName = db.prepare(`SELECT id FROM agent_role_tasks WHERE agent_role_id = ? AND name = ?`)
const insertPermissionIfMissing = db.prepare(`
  INSERT INTO agent_permissions (agent_role_id, resource, action, constraints_json)
  SELECT ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_permissions WHERE agent_role_id = ? AND resource = ? AND action = ?
  )
`)
const insertScheduleIfMissing = db.prepare(`
  INSERT INTO agent_task_schedules (task_id, cron_expr, timezone, enabled, next_run_at, updated_at)
  SELECT ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_task_schedules WHERE task_id = ?
  )
`)
const updateTaskDefinition = db.prepare(`
  UPDATE agent_role_tasks
  SET instructions = ?, input_template_json = ?, output_schema_json = ?, updated_at = CURRENT_TIMESTAMP
  WHERE agent_role_id = ? AND name = ?
`)
const updateTaskRuntime = db.prepare(`
  UPDATE agent_role_tasks
  SET runtime = ?, updated_at = CURRENT_TIMESTAMP
  WHERE agent_role_id = ? AND name = ?
`)
const seedAgentOrgTxn = db.transaction(() => {
  upsertAgentRole.run(
    'Ari',
    'ari-pc-manager',
    'Primary production assistant for the Project Coordinators department.',
    'Coordinate approved AI work for Project Coordinators workflows and route work to specialized workers.',
    'manager',
    null,
    'Project Coordinators',
    'active',
    'builtin-router',
    300000,
    1,
    0,
  )
  const ariId = (roleIdBySlug.get('ari-pc-manager') as { id: number }).id

  upsertAgentRole.run(
    'Outreach Worker',
    'pc-outreach-worker',
    'Drafts approved customer and internal follow-up content for Project Coordinators.',
    'Prepare safe outreach drafts and escalation-ready follow-up summaries for Project Coordinators.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    150000,
    1,
    0,
  )
  upsertAgentRole.run(
    'Status Summary Worker',
    'pc-status-summary-worker',
    'Builds project status summaries and coordinator digests.',
    'Summarize current project state and package repeatable coordinator updates.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    150000,
    1,
    0,
  )
  upsertAgentRole.run(
    'Risk / Hold Worker',
    'pc-risk-hold-worker',
    'Classifies hold risk and identifies blockers for Project Coordinators.',
    'Detect and classify risk, hold reasons, and blocker patterns for Project Coordinators.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-hold-classifier',
    150000,
    1,
    0,
  )
  upsertAgentRole.run(
    'Notes Digest Worker',
    'pc-notes-digest-worker',
    'Builds recent notes digests and activity summaries.',
    'Summarize recent project notes and important activity for Project Coordinators.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    100000,
    1,
    0,
  )
  upsertAgentRole.run(
    'Permit Intelligence Worker',
    'pc-permit-intelligence-worker',
    'Detects permit aging, rejection risk, and AHJ-specific follow-up needs for Project Coordinators.',
    'Surface permit risk early and package the right next action for Project Coordinators.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    120000,
    1,
    0,
  )
  upsertAgentRole.run(
    'Inspection / PTO Worker',
    'pc-inspection-pto-worker',
    'Monitors inspection and PTO handoffs after install complete.',
    'Shrink install-complete to inspection and inspection to PTO delays for Project Coordinators.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    120000,
    1,
    0,
  )
  upsertAgentRole.run(
    'Schedule Integrity Worker',
    'pc-schedule-integrity-worker',
    'Checks scheduled installs and surveys for missing prerequisites or risky sequencing.',
    'Catch scheduling issues before crews roll and turn them into reviewable action items.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    120000,
    1,
    0,
  )
  upsertAgentRole.run(
    'Review Readiness Worker',
    'pc-review-readiness-worker',
    'Identifies customers ready for review outreach and packages approval-ready drafts.',
    'Help Project Coordinators run a reliable review-generation workflow without unsafe auto-send behavior.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    100000,
    1,
    0,
  )
  upsertAgentRole.run(
    'PC Inbox Draft Worker',
    'pc-inbox-draft-worker',
    'Drafts coordinator-facing and homeowner-facing messages for review.',
    'Prepare safe draft communication for Project Coordinators without direct send behavior.',
    'worker',
    ariId,
    'Project Coordinators',
    'active',
    'builtin-worker',
    100000,
    1,
    0,
  )

  insertGoalIfMissing.run(ariId, 'Coordinate PC agent work', 'Route approved Project Coordinator requests to the right worker role and return concise outcomes.', 'PC users get the right routed workflow with visible run status.', 1, 'active', ariId, 'Coordinate PC agent work')
  insertGoalIfMissing.run(ariId, 'Keep production work controlled', 'Require approval before irreversible actions and keep production workflows bounded.', 'No irreversible action executes without approval.', 1, 'active', ariId, 'Keep production work controlled')

  insertTaskIfMissing.run(ariId, 'Intake / route PC requests', 'custom', 'Review a Project Coordinator request, choose the best worker role task, and delegate the work.', '{"kind":"ari_intake"}', '{"result":"delegation_summary"}', 1, ariId, 'Intake / route PC requests')
  insertTaskIfMissing.run(ariId, 'Delegate to worker roles', 'custom', 'Create delegated child runs for approved Project Coordinator worker roles.', '{"kind":"ari_delegate"}', '{"result":"delegation"}', 1, ariId, 'Delegate to worker roles')
  insertTaskIfMissing.run(ariId, 'Summarize outcomes for PC users', 'summary', 'Summarize delegated worker results into a concise outcome for a Project Coordinator.', '{"kind":"ari_summary"}', '{"result":"summary"}', 1, ariId, 'Summarize outcomes for PC users')
  insertTaskIfMissing.run(ariId, 'Run coordinator exception pipeline', 'custom', 'Run the coordinator worker scans, merge the findings, and surface only the highest-signal exceptions for human review.', '{"kind":"ari_pipeline","permit_days":21,"inspection_days":7,"schedule_window_days":2}', '{"result":"exception_pipeline","workflow":"detect_review","approval_required":false}', 1, ariId, 'Run coordinator exception pipeline')

  const outreachId = (roleIdBySlug.get('pc-outreach-worker') as { id: number }).id
  insertGoalIfMissing.run(outreachId, 'Draft outreach safely', 'Produce reviewable outreach drafts without sending directly.', 'Outreach drafts are clear and approval-ready.', 2, 'active', outreachId, 'Draft outreach safely')
  insertTaskIfMissing.run(outreachId, 'Draft customer follow-up', 'outreach', 'Draft a customer-facing follow-up message for a Project Coordinator workflow. Do not send directly.', '{"audience":"customer"}', '{"result":"draft_message"}', 1, outreachId, 'Draft customer follow-up')
  insertTaskIfMissing.run(outreachId, 'Draft internal coordinator follow-up', 'outreach', 'Draft an internal follow-up summary for the Project Coordinator team.', '{"audience":"internal"}', '{"result":"draft_message"}', 1, outreachId, 'Draft internal coordinator follow-up')

  const statusId = (roleIdBySlug.get('pc-status-summary-worker') as { id: number }).id
  insertGoalIfMissing.run(statusId, 'Summarize project status', 'Produce fast, readable project status summaries and daily digests.', 'Summaries are consistent and reusable.', 2, 'active', statusId, 'Summarize project status')
  insertTaskIfMissing.run(statusId, 'Generate project status summary', 'summary', 'Summarize project state, blockers, next milestones, and actions.', '{"scope":"project"}', '{"result":"status_summary"}', 1, statusId, 'Generate project status summary')
  insertTaskIfMissing.run(statusId, 'Generate daily coordinator digest', 'digest', 'Generate a daily digest for a Project Coordinator.', '{"scope":"daily_digest"}', '{"result":"digest"}', 1, statusId, 'Generate daily coordinator digest')
  updateTaskDefinition.run(
    [
      'Generate a morning Project Coordinator briefing using the Slack Block Kit-style digest format.',
      'Include today\'s installs, permit alerts, projects needing attention, good news, and concise action buttons.',
      'For delayed inspections, stuck permits, or funding bottlenecks, calculate delayed ops revenue as system_kW * 1000 * 2.',
      'Do not send to Slack directly. Return a draft briefing and require approval before external posting.',
    ].join(' '),
    JSON.stringify({
      scope: 'daily_digest',
      coordinator: 'string',
      day: 'string',
      installs: [{ rid: 'number|string', customer_name: 'string', location: 'string', lender: 'string', permit_status: 'string', system_kw: 'number' }],
      attention_items: [{ rid: 'number|string', project_name: 'string', issue: 'string', context: 'string', system_kw: 'number' }],
      wins: ['string'],
    }),
    JSON.stringify({
      result: 'slack_block_kit_style_digest_draft',
      sends_message: false,
      requires_approval_before_posting: true,
    }),
    statusId,
    'Generate daily coordinator digest',
  )

  const riskId = (roleIdBySlug.get('pc-risk-hold-worker') as { id: number }).id
  insertGoalIfMissing.run(riskId, 'Classify hold risk', 'Identify hold patterns and blocker causes.', 'Hold projects are categorized with evidence-backed rationale.', 1, 'active', riskId, 'Classify hold risk')
  insertTaskIfMissing.run(riskId, 'Hold classification', 'classification', 'Run the production hold-classifier workflow over hold projects.', '{"scope":"hold_projects"}', '{"result":"classification"}', 1, riskId, 'Hold classification')
  insertTaskIfMissing.run(riskId, 'Blocker detection', 'classification', 'Detect blocker patterns and summarize escalations for Project Coordinators.', '{"scope":"blockers"}', '{"result":"blocker_detection"}', 1, riskId, 'Blocker detection')
  const holdTaskId = (taskIdByRoleAndName.get(riskId, 'Hold classification') as { id: number }).id
  insertScheduleIfMissing.run(holdTaskId, '0 2 * * *', 'America/Los_Angeles', 1, null, holdTaskId)

  const ariPipelineTaskId = (taskIdByRoleAndName.get(ariId, 'Run coordinator exception pipeline') as { id: number }).id
  insertScheduleIfMissing.run(ariPipelineTaskId, '0 7 * * *', 'America/Denver', 1, null, ariPipelineTaskId)

  const notesId = (roleIdBySlug.get('pc-notes-digest-worker') as { id: number }).id
  insertGoalIfMissing.run(notesId, 'Summarize recent notes', 'Turn recent project notes into usable coordinator updates.', 'Recent activity can be scanned quickly by PCs.', 2, 'active', notesId, 'Summarize recent notes')
  insertTaskIfMissing.run(notesId, 'Recent notes digest', 'digest', 'Summarize the most recent notes for a project or coordinator queue.', '{"scope":"recent_notes"}', '{"result":"digest"}', 1, notesId, 'Recent notes digest')
  insertTaskIfMissing.run(notesId, 'Key activity summary', 'summary', 'Summarize key project activity and notable changes.', '{"scope":"activity"}', '{"result":"activity_summary"}', 1, notesId, 'Key activity summary')

  const permitIntelId = (roleIdBySlug.get('pc-permit-intelligence-worker') as { id: number }).id
  insertGoalIfMissing.run(permitIntelId, 'Surface permit blockers early', 'Detect permits that are aging, rejected, or moving outside expected AHJ timelines.', 'Permit risks appear in Agent Ops before they turn into fire drills.', 1, 'active', permitIntelId, 'Surface permit blockers early')
  insertTaskIfMissing.run(permitIntelId, 'Permit aging alert scan', 'classification', 'Scan active projects for permits past expected aging thresholds and package the next coordinator action.', '{"scope":"permit_aging","permit_days":21}', '{"result":"risk_cards","approval_required":false,"workflow":"detect_review"}', 1, permitIntelId, 'Permit aging alert scan')
  insertTaskIfMissing.run(permitIntelId, 'Draft AHJ follow-up call script', 'outreach', 'Draft an AHJ follow-up script for a coordinator to review before any external outreach.', '{"scope":"permit_follow_up"}', '{"result":"draft_call_script","approval_required":true}', 1, permitIntelId, 'Draft AHJ follow-up call script')

  const inspectionPtoId = (roleIdBySlug.get('pc-inspection-pto-worker') as { id: number }).id
  insertGoalIfMissing.run(inspectionPtoId, 'Reduce post-install drag', 'Detect stalled projects between install complete, inspection, and PTO.', 'Project Coordinators get reviewable exception lists before cashflow-impacting delays grow.', 1, 'active', inspectionPtoId, 'Reduce post-install drag')
  insertTaskIfMissing.run(inspectionPtoId, 'Install complete without inspection follow-up', 'classification', 'Scan for install-complete projects with no inspection follow-up and package the recommended next step.', '{"scope":"ic_no_inspection","inspection_days":7}', '{"result":"risk_cards","approval_required":false,"workflow":"detect_review"}', 1, inspectionPtoId, 'Install complete without inspection follow-up')
  insertTaskIfMissing.run(inspectionPtoId, 'Inspection passed without PTO follow-up', 'classification', 'Scan for inspection-passed projects that are still waiting on PTO follow-up.', '{"scope":"inspection_no_pto","inspection_days":7}', '{"result":"risk_cards","approval_required":false,"workflow":"detect_review"}', 1, inspectionPtoId, 'Inspection passed without PTO follow-up')
  updateTaskDefinition.run(
    [
      'Run the install-to-inspection case workflow.',
      'Do not surface raw detection output immediately.',
      'Investigate with worker-style checks across Arrivy, QuickBase notes, permit context, and existing Agent Ops follow-up tasks.',
      'Only surface unresolved or approval-worthy cases to humans.',
      'Return a structured case report with checks performed, classification, confidence, recommended next owner, and why HITL is still needed.',
    ].join(' '),
    JSON.stringify({
      scope: 'ic_no_inspection',
      inspection_days: 7,
      workflow_key: 'pc_install_to_inspection_case',
      stages: ['detect', 'schedule_check', 'notes_check', 'permit_check', 'internal_task_check', 'classify', 'hitl_if_needed'],
    }),
    JSON.stringify({
      result: 'case_report',
      workflow: 'case_workflow',
      approval_required: false,
      openclaw_adapter: 'ready_for_runner',
    }),
    inspectionPtoId,
    'Install complete without inspection follow-up',
  )
  updateTaskRuntime.run('openclaw', inspectionPtoId, 'Install complete without inspection follow-up')

  const scheduleIntegrityId = (roleIdBySlug.get('pc-schedule-integrity-worker') as { id: number }).id
  insertGoalIfMissing.run(scheduleIntegrityId, 'Catch risky scheduling early', 'Flag installs or surveys that are moving without the right prerequisites.', 'Crew-impacting schedule problems are reviewed before they become day-of surprises.', 2, 'active', scheduleIntegrityId, 'Catch risky scheduling early')
  insertTaskIfMissing.run(scheduleIntegrityId, 'Install scheduled without permit check', 'classification', 'Review upcoming installs for projects that still do not show permit approval.', '{"scope":"scheduled_without_permit","schedule_window_days":2}', '{"result":"risk_cards","approval_required":false,"workflow":"detect_review"}', 1, scheduleIntegrityId, 'Install scheduled without permit check')

  const reviewReadyId = (roleIdBySlug.get('pc-review-readiness-worker') as { id: number }).id
  insertGoalIfMissing.run(reviewReadyId, 'Package review-ready outreach safely', 'Identify strong review candidates and stage coordinator-approved outreach.', 'Review asks are consistent, trackable, and never auto-sent.', 3, 'active', reviewReadyId, 'Package review-ready outreach safely')
  insertTaskIfMissing.run(reviewReadyId, 'Draft review request outreach', 'outreach', 'Prepare a draft review request for a coordinator-approved customer outreach sequence.', '{"scope":"review_request"}', '{"result":"draft_message","approval_required":true}', 1, reviewReadyId, 'Draft review request outreach')

  const inboxDraftId = (roleIdBySlug.get('pc-inbox-draft-worker') as { id: number }).id
  insertGoalIfMissing.run(inboxDraftId, 'Keep coordinator communication draft-first', 'Prepare useful coordinator and homeowner-facing drafts without bypassing human review.', 'Coordinators can approve, edit, or discard suggested communication quickly.', 3, 'active', inboxDraftId, 'Keep coordinator communication draft-first')
  insertTaskIfMissing.run(inboxDraftId, 'Draft homeowner status update', 'outreach', 'Draft a homeowner-facing project update for coordinator review before any send action.', '{"scope":"homeowner_update"}', '{"result":"draft_message","approval_required":true}', 1, inboxDraftId, 'Draft homeowner status update')

  for (const slug of ['ari-pc-manager', 'pc-outreach-worker', 'pc-status-summary-worker', 'pc-risk-hold-worker', 'pc-notes-digest-worker', 'pc-permit-intelligence-worker', 'pc-inspection-pto-worker', 'pc-schedule-integrity-worker', 'pc-review-readiness-worker', 'pc-inbox-draft-worker']) {
    const roleId = (roleIdBySlug.get(slug) as { id: number }).id
    insertPermissionIfMissing.run(roleId, 'projects', 'read', null, roleId, 'projects', 'read')
    insertPermissionIfMissing.run(roleId, 'notes', 'read', null, roleId, 'notes', 'read')
    insertPermissionIfMissing.run(roleId, 'tickets', 'read', null, roleId, 'tickets', 'read')
    insertPermissionIfMissing.run(roleId, 'notifications', 'summarize', null, roleId, 'notifications', 'summarize')
    insertPermissionIfMissing.run(roleId, 'arrivy', 'read', null, roleId, 'arrivy', 'read')
    insertPermissionIfMissing.run(roleId, 'front', 'read', null, roleId, 'front', 'read')
    insertPermissionIfMissing.run(roleId, 'external_message', 'request_approval', '{"mode":"draft_only"}', roleId, 'external_message', 'request_approval')
  }
})
seedAgentOrgTxn()

export default db
