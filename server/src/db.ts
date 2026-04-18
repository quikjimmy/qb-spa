import Database from 'better-sqlite3'
import path from 'path'

const dbPath = path.resolve(process.cwd(), 'portal.db')
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

// --- Seed default roles if they don't exist ---
const seedRoles = db.prepare(`
  INSERT OR IGNORE INTO roles (name, description, is_system) VALUES (?, ?, ?)
`)
const seedTransaction = db.transaction(() => {
  seedRoles.run('admin', 'Full access to all portal features and settings', 1)
  seedRoles.run('customer', 'View own project status and milestones', 1)
  seedRoles.run('lender', 'View portfolio of financed projects', 1)
  seedRoles.run('crew', 'View and update assigned field tasks', 1)
})
seedTransaction()

export default db
