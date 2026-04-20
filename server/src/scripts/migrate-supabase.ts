import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg

const pool = new Pool({
  host: 'db.botydxyerveedbbmkzgi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: process.env['SUPABASE_DB_PASSWORD'],
  ssl: { rejectUnauthorized: false },
})

const SCHEMA = `
-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  invite_token TEXT UNIQUE,
  invite_expires_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roles
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0,
  qb_role_id INTEGER UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User <-> Role
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Permissions
CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('view', 'table', 'field')),
  resource_id TEXT NOT NULL,
  can_read INTEGER NOT NULL DEFAULT 1,
  can_write INTEGER NOT NULL DEFAULT 0,
  UNIQUE (role_id, resource_type, resource_id)
);

-- Record Filters
CREATE TABLE IF NOT EXISTS record_filters (
  id SERIAL PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL,
  qb_email_field_id INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (role_id, table_id)
);

-- Feed Items
CREATE TABLE IF NOT EXISTS feed_items (
  id SERIAL PRIMARY KEY,
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
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (qb_source, qb_record_id, event_type, occurred_at)
);
CREATE INDEX IF NOT EXISTS idx_feed_occurred ON feed_items(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_actor ON feed_items(actor_email);
CREATE INDEX IF NOT EXISTS idx_feed_project ON feed_items(project_id);

-- Media Attachments
CREATE TABLE IF NOT EXISTS media_attachments (
  id SERIAL PRIMARY KEY,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_feed ON media_attachments(feed_item_id);

-- Comments
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  feed_item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_feed ON comments(feed_item_id);

-- Reactions
CREATE TABLE IF NOT EXISTS reactions (
  id SERIAL PRIMARY KEY,
  feed_item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feed_item_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_feed ON reactions(feed_item_id);

-- Favorites
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

-- Project Cache
CREATE TABLE IF NOT EXISTS project_cache (
  record_id INTEGER PRIMARY KEY,
  customer_name TEXT,
  customer_address TEXT,
  email TEXT,
  phone TEXT,
  status TEXT,
  sales_office TEXT,
  lender TEXT,
  closer TEXT,
  coordinator TEXT,
  system_size_kw REAL,
  sales_date TEXT,
  state TEXT,
  intake_completed TEXT,
  survey_scheduled TEXT,
  survey_submitted TEXT,
  survey_approved TEXT,
  cad_submitted TEXT,
  design_completed TEXT,
  nem_submitted TEXT,
  nem_approved TEXT,
  nem_rejected TEXT,
  permit_submitted TEXT,
  permit_approved TEXT,
  permit_rejected TEXT,
  install_scheduled TEXT,
  install_completed TEXT,
  inspection_scheduled TEXT,
  inspection_passed TEXT,
  pto_submitted TEXT,
  pto_approved TEXT,
  epc TEXT,
  nem_user TEXT,
  inspx_first_time_pass INTEGER,
  inspx_pass_fail TEXT,
  inspx_fail_date TEXT,
  inspx_count INTEGER DEFAULT 0,
  inspx_passed_count INTEGER DEFAULT 0,
  next_task_type TEXT,
  next_task_date TEXT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pc_status ON project_cache(status);
CREATE INDEX IF NOT EXISTS idx_pc_name ON project_cache(customer_name);

-- Agent Runs
CREATE TABLE IF NOT EXISTS agent_runs (
  id SERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  projects_scanned INTEGER DEFAULT 0,
  projects_classified INTEGER DEFAULT 0,
  projects_skipped INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,
  model TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent, started_at DESC);

-- Agent Outputs
CREATE TABLE IF NOT EXISTS agent_outputs (
  id SERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent, project_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_project ON agent_outputs(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent, generated_at DESC);

-- Outreach Cache (pending)
CREATE TABLE IF NOT EXISTS outreach_cache (
  record_id INTEGER PRIMARY KEY,
  project_rid INTEGER,
  touchpoint_name TEXT,
  customer_name TEXT,
  project_status TEXT,
  project_state TEXT,
  project_lender TEXT,
  preferred_outreach TEXT,
  due_date TEXT,
  update_outreach TEXT,
  project_coordinator TEXT,
  coordinator_user TEXT,
  outreach_completed_date TEXT,
  display_order REAL,
  outreach_status TEXT,
  attempts INTEGER DEFAULT 0,
  is_unresponsive TEXT,
  preferred_comms TEXT,
  note TEXT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outreach_touchpoint ON outreach_cache(touchpoint_name);
CREATE INDEX IF NOT EXISTS idx_outreach_coordinator ON outreach_cache(project_coordinator);
CREATE INDEX IF NOT EXISTS idx_outreach_project ON outreach_cache(project_rid);

-- Outreach Completed Cache (analytics)
CREATE TABLE IF NOT EXISTS outreach_completed_cache (
  record_id INTEGER PRIMARY KEY,
  project_rid INTEGER,
  touchpoint_name TEXT,
  customer_name TEXT,
  project_coordinator TEXT,
  outreach_completed_date TEXT,
  due_date TEXT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oc_touchpoint ON outreach_completed_cache(touchpoint_name);
CREATE INDEX IF NOT EXISTS idx_oc_coordinator ON outreach_completed_cache(project_coordinator);

-- Inspections Cache
CREATE TABLE IF NOT EXISTS inspx_cache (
  record_id INTEGER PRIMARY KEY,
  project_rid INTEGER,
  project_name TEXT,
  state TEXT,
  epc TEXT,
  inspection_type TEXT,
  inspection_scheduled TEXT,
  inspection_completed TEXT,
  pass_fail TEXT,
  official_pass_fail TEXT,
  fail_reason TEXT,
  age_bucket TEXT,
  install_completed TEXT,
  todo TEXT,
  date_created TEXT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default roles
INSERT INTO roles (name, description, is_system) VALUES ('admin', 'Full access to all portal features and settings', 1) ON CONFLICT (name) DO NOTHING;
INSERT INTO roles (name, description, is_system) VALUES ('customer', 'View own project status and milestones', 1) ON CONFLICT (name) DO NOTHING;
INSERT INTO roles (name, description, is_system) VALUES ('lender', 'View portfolio of financed projects', 1) ON CONFLICT (name) DO NOTHING;
INSERT INTO roles (name, description, is_system) VALUES ('crew', 'View and update assigned field tasks', 1) ON CONFLICT (name) DO NOTHING;
`

async function main() {
  console.log('Connecting to Supabase Postgres...')
  const client = await pool.connect()

  try {
    // Split by statement and execute each
    const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'))
    console.log(`Executing ${statements.length} statements...`)

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 80)
      try {
        await client.query(stmt)
        console.log(`  ✓ [${i + 1}/${statements.length}] ${preview}...`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`  ✗ [${i + 1}/${statements.length}] ${preview}...`)
        console.log(`    Error: ${msg}`)
      }
    }

    // Verify tables
    const { rows } = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    )
    console.log(`\nTables created (${rows.length}):`)
    for (const r of rows) console.log(`  ${r.tablename}`)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(console.error)
