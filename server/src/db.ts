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
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent, started_at DESC)`)

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

// --- Per-user Ollama connection (encrypted at rest) ---
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
    instructions TEXT NOT NULL,
    input_template_json TEXT,
    output_schema_json TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)
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
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_delivery_items_user ON agent_delivery_items(user_id, read_at, created_at DESC)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_delivery_items_run ON agent_delivery_items(task_run_id)`)

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

  insertGoalIfMissing.run(ariId, 'Coordinate PC agent work', 'Route approved Project Coordinator requests to the right worker role and return concise outcomes.', 'PC users get the right routed workflow with visible run status.', 1, 'active', ariId, 'Coordinate PC agent work')
  insertGoalIfMissing.run(ariId, 'Keep production work controlled', 'Require approval before irreversible actions and keep production workflows bounded.', 'No irreversible action executes without approval.', 1, 'active', ariId, 'Keep production work controlled')

  insertTaskIfMissing.run(ariId, 'Intake / route PC requests', 'custom', 'Review a Project Coordinator request, choose the best worker role task, and delegate the work.', '{"kind":"ari_intake"}', '{"result":"delegation_summary"}', 1, ariId, 'Intake / route PC requests')
  insertTaskIfMissing.run(ariId, 'Delegate to worker roles', 'custom', 'Create delegated child runs for approved Project Coordinator worker roles.', '{"kind":"ari_delegate"}', '{"result":"delegation"}', 1, ariId, 'Delegate to worker roles')
  insertTaskIfMissing.run(ariId, 'Summarize outcomes for PC users', 'summary', 'Summarize delegated worker results into a concise outcome for a Project Coordinator.', '{"kind":"ari_summary"}', '{"result":"summary"}', 1, ariId, 'Summarize outcomes for PC users')

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

  const notesId = (roleIdBySlug.get('pc-notes-digest-worker') as { id: number }).id
  insertGoalIfMissing.run(notesId, 'Summarize recent notes', 'Turn recent project notes into usable coordinator updates.', 'Recent activity can be scanned quickly by PCs.', 2, 'active', notesId, 'Summarize recent notes')
  insertTaskIfMissing.run(notesId, 'Recent notes digest', 'digest', 'Summarize the most recent notes for a project or coordinator queue.', '{"scope":"recent_notes"}', '{"result":"digest"}', 1, notesId, 'Recent notes digest')
  insertTaskIfMissing.run(notesId, 'Key activity summary', 'summary', 'Summarize key project activity and notable changes.', '{"scope":"activity"}', '{"result":"activity_summary"}', 1, notesId, 'Key activity summary')

  for (const slug of ['ari-pc-manager', 'pc-outreach-worker', 'pc-status-summary-worker', 'pc-risk-hold-worker', 'pc-notes-digest-worker']) {
    const roleId = (roleIdBySlug.get(slug) as { id: number }).id
    insertPermissionIfMissing.run(roleId, 'projects', 'read', null, roleId, 'projects', 'read')
    insertPermissionIfMissing.run(roleId, 'notes', 'read', null, roleId, 'notes', 'read')
    insertPermissionIfMissing.run(roleId, 'tickets', 'read', null, roleId, 'tickets', 'read')
    insertPermissionIfMissing.run(roleId, 'notifications', 'summarize', null, roleId, 'notifications', 'summarize')
    insertPermissionIfMissing.run(roleId, 'external_message', 'request_approval', '{"mode":"draft_only"}', roleId, 'external_message', 'request_approval')
  }
})
seedAgentOrgTxn()

export default db
