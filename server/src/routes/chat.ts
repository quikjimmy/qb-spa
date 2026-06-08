import { Router, type Request, type Response } from 'express'
import db from '../db'
import { callUserLlm, type ChatMessage } from '../lib/callUserLlm'
import { getDefaultKeyFor, type ProviderId } from '../lib/userProviderKeys'
import { getSnapshot } from '../lib/providerRateLimits'
import { getQbTools, callQbTool, qbMcpStatus } from '../lib/qbMcp'
import { dispatchToAri, ariStatus, workspaceForProjectThread } from '../lib/ariClient'
import { notifyChatComplete } from '../lib/notify'

const router = Router()

interface ThreadRow {
  id: number
  user_id: number
  title: string
  project_id: number | null
  space_id: number | null
  preferred_provider: string | null
  preferred_model: string | null
  openclaw_session_key: string | null
  archived: number
  created_at: string
  updated_at: string
  last_message_at: string | null
}

interface SpaceRow {
  id: number
  user_id: number
  project_id: number
  name: string
  system_instructions: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
}

interface MessageRow {
  id: number
  thread_id: number
  role: string
  content: string
  provider: string | null
  model: string | null
  tokens_in: number
  tokens_out: number
  cost_cents: number
  used_own_key: number | null
  tool_calls_json: string | null
  error: string | null
  status: string
  created_at: string
}

interface ProjectRow {
  record_id: number
  customer_name: string | null
  status: string | null
  state: string | null
  system_size_kw: number | null
  sales_date: string | null
  coordinator: string | null
  closer: string | null
  lender: string | null
}

function getProject(id: number): ProjectRow | undefined {
  return db.prepare(
    `SELECT record_id, customer_name, status, state, system_size_kw, sales_date, coordinator, closer, lender
       FROM project_cache WHERE record_id = ?`
  ).get(id) as ProjectRow | undefined
}

// Idempotent: returns the existing space for (user, projectId) or creates one.
// Used by both manual "+ Add project" and the project view's side-panel auto-open.
function getOrCreateSpace(userId: number, projectId: number): SpaceRow {
  const existing = db.prepare(`SELECT * FROM chat_spaces WHERE user_id = ? AND project_id = ?`).get(userId, projectId) as SpaceRow | undefined
  if (existing) return existing
  const project = getProject(projectId)
  const name = project?.customer_name || `Project ${projectId}`
  const r = db.prepare(`INSERT INTO chat_spaces (user_id, project_id, name) VALUES (?, ?, ?)`).run(userId, projectId, name)
  return db.prepare(`SELECT * FROM chat_spaces WHERE id = ?`).get(Number(r.lastInsertRowid)) as SpaceRow
}

function shapeSpace(s: SpaceRow): Record<string, unknown> {
  const threadCount = (db.prepare(`SELECT COUNT(*) AS n FROM chat_threads WHERE space_id = ? AND archived = 0`).get(s.id) as { n: number }).n
  return {
    id: s.id,
    project_id: s.project_id,
    name: s.name,
    system_instructions: s.system_instructions,
    thread_count: threadCount,
    created_at: s.created_at,
    last_used_at: s.last_used_at,
  }
}

// System-prompt builder. Two modes:
//
// (1) MCP-OFF (no QB tools available) — strict anti-hallucination mode:
//     enumerate what's loaded, refuse anything else with a fixed phrase.
//
// (2) MCP-ON (QB tools available) — the model has read-only QuickBase tools
//     it can call. The prompt directs it to USE the tools to answer instead
//     of refusing, and stay grounded in what the tools return. We still
//     forbid invention; the model must cite the tool/field it queried.
//
// Resolution order for project context:
//   1. thread.space_id → space.project_id (Spaces model)
//   2. thread.project_id (legacy/general thread with one-off attachment)
const REFUSAL_PHRASE = `I don't have that information in this conversation. Try opening the project page directly, or ask an admin to wire that data into the chatbot.`

function buildSystemContext(thread: ThreadRow, mcpEnabled: boolean): string {
  let projectId: number | null = null
  let extraInstructions: string | null = null
  if (thread.space_id) {
    const space = db.prepare(`SELECT project_id, system_instructions FROM chat_spaces WHERE id = ?`).get(thread.space_id) as { project_id: number; system_instructions: string | null } | undefined
    if (space) {
      projectId = space.project_id
      extraInstructions = space.system_instructions
    }
  }
  if (!projectId && thread.project_id) projectId = thread.project_id

  // Common preamble — branches on whether QB MCP tools are wired in.
  const preamble = [
    `You are a helpful assistant inside the Kin Home ops portal (a solar installation company's internal tool).`,
    ``,
    `# Critical rules`,
    `1. Be concise and direct. No filler phrases like "Great question!".`,
    mcpEnabled
      ? `2. You have read-only QuickBase tools available. When the user asks about projects, notes, tickets, milestones, communications, or any other operational data, USE THE TOOLS to fetch real data rather than guessing or refusing. Start with \`describe_realm\` if you don't know the schema yet; use \`resolve_term\` when the user's wording is ambiguous (e.g. "install complete").`
      : `2. ONLY use information explicitly provided in this prompt or in earlier conversation turns. Do NOT use prior knowledge about Kin Home, specific projects, customers, or solar industry specifics unless directly stated here.`,
    mcpEnabled
      ? `3. If a tool returns no results or errors, say so plainly. Do not invent values to fill gaps. If a question is genuinely outside QuickBase (e.g. private opinions, unrelated topics), say you can only answer from QuickBase data.`
      : `3. If asked about anything outside the data shown below, respond with EXACTLY this phrase and nothing else: "${REFUSAL_PHRASE}"`,
    `4. Never fabricate dates, names, statuses, milestones, ticket details, notes, communications, financials, schedules, equipment specs, or any other field. Cite the source (the field name${mcpEnabled ? ' and the tool you called' : ''}) when you answer.`,
    mcpEnabled
      ? `5. Quickbase has many near-duplicate field labels. When in doubt about which field the user means, call \`resolve_term\` before querying. Don't eyeball-match labels.`
      : `5. If you are uncertain whether information is in scope, refuse using the phrase above. Confident-sounding guesses are worse than refusals.`,
    `6. Be efficient with tool calls. Batch what you can; don't fetch entire tables when a filter or count would do.`,
  ].join('\n')

  if (!projectId) {
    if (mcpEnabled) {
      const generalScope = [
        ``,
        `# Context`,
        `No specific project is attached to this thread. The user can attach one via the "+ Add project context" button to scope your questions to a single record — until then, treat questions as realm-wide.`,
        ``,
        `Common starting points for general questions:`,
        `- "How many projects are on hold?" → \`count_records\` on the projects table with a status filter.`,
        `- "Show me recent intakes" → \`query_records\` on the projects table, ordered by sales date desc.`,
        `- "What does <term> mean in our realm?" → \`resolve_term\` then describe the canonical field.`,
      ].join('\n')
      return preamble + '\n' + generalScope
    }
    // MCP-off general chat — virtually no data available.
    const generalScope = [
      ``,
      `# Available data`,
      `- The current conversation history (above this message in the chat).`,
      `- The user's name (if mentioned in chat).`,
      ``,
      `# NOT available (refuse if asked)`,
      `- Any specific project, customer, ticket, communication, schedule, financial, equipment, or milestone data.`,
      `- Any list of projects, users, or operational status.`,
      `- Any data from QuickBase, Dialpad, or other integrated systems.`,
      ``,
      `If the user wants to ask about a specific project, suggest they attach a project to this thread (the "+ Add project context" button below the message box).`,
    ].join('\n')
    return preamble + '\n' + generalScope
  }

  const project = getProject(projectId)
  if (!project) {
    return preamble + `\n\n# Available data\n- A project was attached to this conversation but its data could not be loaded.\n\nResponse: tell the user to reload the page.`
  }

  // PROJECT chat — show what's pre-loaded (no tool call needed for these).
  const fields = [
    `- Customer name: ${project.customer_name ?? '(empty)'}`,
    `- QuickBase record ID: ${project.record_id}`,
    `- Status: ${project.status ?? '(empty)'}`,
    `- State (location): ${project.state ?? '(empty)'}`,
    `- System size: ${project.system_size_kw ? `${project.system_size_kw} kW` : '(empty)'}`,
    `- Sales date: ${project.sales_date ?? '(empty)'}`,
    `- Project Coordinator: ${project.coordinator ?? '(empty)'}`,
    `- Closer (sales rep): ${project.closer ?? '(empty)'}`,
    `- Lender: ${project.lender ?? '(empty)'}`,
  ]

  let scope: string
  if (mcpEnabled) {
    scope = [
      ``,
      `# Pre-loaded project summary (no tool call needed for these)`,
      ...fields,
      ``,
      `# Everything else about this project`,
      `Fetch from QuickBase via the tools. The project's record ID is **${project.record_id}** — pass that as the project filter when querying notes, tickets, milestones, communications, equipment, financials, schedule, inspections, etc. on related tables.`,
      `If you don't know which table or field a concept lives on, call \`resolve_term\` or \`search_fields\` first.`,
    ].join('\n')
  } else {
    scope = [
      ``,
      `# Available data for this project`,
      ...fields,
      ``,
      `# NOT available for this project (refuse if asked)`,
      `- Notes, comments, or activity log entries`,
      `- Tickets, issues, or open work items`,
      `- Communications: SMS messages, calls, emails, voicemails`,
      `- Milestone dates beyond what's listed above (intake, survey, design, NEM, permit, install, inspection, PTO submission/approval dates are NOT loaded into this conversation)`,
      `- Equipment details: panel/inverter brand, count, production estimate`,
      `- Financial details: system price, dealer fees, net cost, M1/M2/M3 funding status`,
      `- Address or contact info (phone, email)`,
      `- Crew assignments, install schedule, or calendar events`,
      `- Inspection results, AHJ, utility company`,
      `- Any data about other projects, even similar ones`,
      ``,
      `When asked about anything in the NOT available list, use the refusal phrase. Do NOT invent values.`,
    ].join('\n')
  }

  let context = preamble + '\n' + scope
  if (extraInstructions) context += '\n\n# Additional instructions for this project workspace\n' + extraInstructions
  return context
}

function shapeThread(t: ThreadRow): Record<string, unknown> {
  let projectName: string | null = null
  let spaceName: string | null = null
  let projectId: number | null = t.project_id

  if (t.space_id) {
    const space = db.prepare(`SELECT name, project_id FROM chat_spaces WHERE id = ?`).get(t.space_id) as { name: string; project_id: number } | undefined
    if (space) {
      spaceName = space.name
      projectId = space.project_id
      projectName = space.name
    }
  } else if (projectId) {
    const p = db.prepare(`SELECT customer_name FROM project_cache WHERE record_id = ?`).get(projectId) as { customer_name: string | null } | undefined
    projectName = p?.customer_name || null
  }

  return {
    id: t.id, title: t.title,
    project_id: projectId, project_name: projectName,
    space_id: t.space_id, space_name: spaceName,
    preferred_provider: t.preferred_provider,
    preferred_model: t.preferred_model,
    archived: t.archived === 1,
    created_at: t.created_at, updated_at: t.updated_at, last_message_at: t.last_message_at,
  }
}

function shapeMessage(m: MessageRow): Record<string, unknown> {
  // Parse tool_calls_json defensively — if it ever ends up malformed we'd
  // rather drop the field on the wire than 500 the whole thread fetch.
  let toolCalls: unknown = null
  if (m.tool_calls_json) {
    try { toolCalls = JSON.parse(m.tool_calls_json) } catch { toolCalls = null }
  }
  return {
    id: m.id, role: m.role, content: m.content,
    provider: m.provider, model: m.model,
    tokens_in: m.tokens_in, tokens_out: m.tokens_out, cost_cents: m.cost_cents,
    used_own_key: m.used_own_key === 1,
    tool_calls: toolCalls,
    error: m.error, status: m.status, created_at: m.created_at,
  }
}

// GET /api/chat/threads — list current user's threads
// Filters:
//   ?space_id=N         only threads in that space
//   ?space_id=none      only general (no-space) threads
//   default             all
router.get('/threads', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const includeArchived = req.query['include_archived'] === '1'
  const spaceFilter = req.query['space_id'] as string | undefined

  let extra = ''
  const params: unknown[] = [userId]
  if (spaceFilter === 'none') {
    extra = 'AND space_id IS NULL'
  } else if (spaceFilter && /^\d+$/.test(spaceFilter)) {
    extra = 'AND space_id = ?'
    params.push(parseInt(spaceFilter, 10))
  }

  const rows = db.prepare(
    `SELECT * FROM chat_threads
      WHERE user_id = ? ${includeArchived ? '' : 'AND archived = 0'} ${extra}
      ORDER BY COALESCE(last_message_at, created_at) DESC
      LIMIT 200`
  ).all(...params) as ThreadRow[]
  res.json({ threads: rows.map(shapeThread) })
})

// GET /api/chat/spaces — list this user's project workspaces
router.get('/spaces', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const rows = db.prepare(
    `SELECT * FROM chat_spaces WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC`
  ).all(userId) as SpaceRow[]
  res.json({ spaces: rows.map(shapeSpace) })
})

// POST /api/chat/spaces/from-project/:projectId — get-or-create the user's space
// for a QB project. Used by ProjectDetailView's chat panel button.
router.post('/spaces/from-project/:projectId', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const projectId = parseInt(String(req.params['projectId']), 10)
  if (!Number.isFinite(projectId) || projectId <= 0) { res.status(400).json({ error: 'Invalid projectId' }); return }
  const space = getOrCreateSpace(userId, projectId)
  db.prepare(`UPDATE chat_spaces SET last_used_at = datetime('now') WHERE id = ?`).run(space.id)
  res.json(shapeSpace(space))
})

// PATCH /api/chat/spaces/:id — rename or update system instructions
router.patch('/spaces/:id', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  const space = db.prepare(`SELECT * FROM chat_spaces WHERE id = ? AND user_id = ?`).get(id, userId) as SpaceRow | undefined
  if (!space) { res.status(404).json({ error: 'Space not found' }); return }
  const { name, system_instructions } = req.body as { name?: string; system_instructions?: string | null }
  if (name !== undefined) {
    db.prepare(`UPDATE chat_spaces SET name = ?, updated_at = datetime('now') WHERE id = ?`).run((name || '').trim() || space.name, id)
  }
  if (system_instructions !== undefined) {
    const v = (system_instructions || '').toString().trim()
    db.prepare(`UPDATE chat_spaces SET system_instructions = ?, updated_at = datetime('now') WHERE id = ?`).run(v || null, id)
  }
  const updated = db.prepare(`SELECT * FROM chat_spaces WHERE id = ?`).get(id) as SpaceRow
  res.json(shapeSpace(updated))
})

// DELETE /api/chat/spaces/:id — also cascades thread cleanup (FK ON DELETE SET NULL keeps threads, just unbinds)
router.delete('/spaces/:id', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  const space = db.prepare(`SELECT id FROM chat_spaces WHERE id = ? AND user_id = ?`).get(id, userId)
  if (!space) { res.status(404).json({ error: 'Space not found' }); return }
  // Delete threads in this space too — Spaces are workspaces; deleting one
  // takes its conversations with it (matches user mental model).
  db.prepare(`DELETE FROM chat_threads WHERE space_id = ?`).run(id)
  db.prepare(`DELETE FROM chat_spaces WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// POST /api/chat/threads — create a new thread.
// Body: { title?, space_id? } — if space_id is provided, thread joins that space
// and inherits its project context. Without space_id, this is a general thread.
// Threads inside a space default their title to the space's customer name
// so the user can scan space-thread lists by customer rather than seeing
// repeated "New chat" rows.
router.post('/threads', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const { title, space_id } = req.body as { title?: string; space_id?: number | null }
  let spaceId: number | null = null
  let derivedTitle = (title || '').trim()

  if (space_id != null) {
    const sid = Number(space_id)
    const owns = db.prepare(`SELECT id, name FROM chat_spaces WHERE id = ? AND user_id = ?`).get(sid, userId) as { id: number; name: string } | undefined
    if (!owns) { res.status(400).json({ error: 'Invalid space_id' }); return }
    spaceId = sid
    if (!derivedTitle) derivedTitle = owns.name
    db.prepare(`UPDATE chat_spaces SET last_used_at = datetime('now') WHERE id = ?`).run(sid)
  }
  if (!derivedTitle) derivedTitle = 'New chat'

  const result = db.prepare(
    `INSERT INTO chat_threads (user_id, title, space_id) VALUES (?, ?, ?)`
  ).run(userId, derivedTitle, spaceId)
  const t = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(Number(result.lastInsertRowid)) as ThreadRow
  res.json(shapeThread(t))
})

// GET /api/chat/threads/:id — full thread with messages
router.get('/threads/:id', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  const t = db.prepare(`SELECT * FROM chat_threads WHERE id = ? AND user_id = ?`).get(id, userId) as ThreadRow | undefined
  if (!t) { res.status(404).json({ error: 'Thread not found' }); return }
  const messages = db.prepare(
    `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC`
  ).all(id) as MessageRow[]
  res.json({ thread: shapeThread(t), messages: messages.map(shapeMessage) })
})

// PATCH /api/chat/threads/:id — update title, project context, or archive.
// Setting project_id (when no space exists for that user+project) auto-creates
// a Space and binds the thread to it. Clearing project_id detaches the space.
router.patch('/threads/:id', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  const t = db.prepare(`SELECT * FROM chat_threads WHERE id = ? AND user_id = ?`).get(id, userId) as ThreadRow | undefined
  if (!t) { res.status(404).json({ error: 'Thread not found' }); return }

  const { title, project_id, space_id, archived, preferred_provider, preferred_model } = req.body as { title?: string; project_id?: number | null; space_id?: number | null; archived?: boolean; preferred_provider?: 'anthropic' | 'openai' | 'ollama' | null; preferred_model?: string | null }
  if (title !== undefined) {
    db.prepare(`UPDATE chat_threads SET title = ?, updated_at = datetime('now') WHERE id = ?`).run((title || '').trim() || 'New chat', id)
  }
  if (project_id !== undefined) {
    if (project_id == null) {
      db.prepare(`UPDATE chat_threads SET project_id = NULL, space_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(id)
    } else {
      const pid = Number(project_id)
      const space = getOrCreateSpace(userId, pid)
      db.prepare(`UPDATE chat_threads SET space_id = ?, project_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(space.id, id)
      db.prepare(`UPDATE chat_spaces SET last_used_at = datetime('now') WHERE id = ?`).run(space.id)
      // Default-title the thread to the project name unless the user has already named it.
      if (t.title === 'New chat' || !t.title) {
        db.prepare(`UPDATE chat_threads SET title = ? WHERE id = ?`).run(space.name, id)
      }
    }
  } else if (space_id !== undefined) {
    if (space_id == null) {
      db.prepare(`UPDATE chat_threads SET space_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(id)
    } else {
      const sid = Number(space_id)
      const owns = db.prepare(`SELECT id, name FROM chat_spaces WHERE id = ? AND user_id = ?`).get(sid, userId) as { id: number; name: string } | undefined
      if (!owns) { res.status(400).json({ error: 'Invalid space_id' }); return }
      db.prepare(`UPDATE chat_threads SET space_id = ?, updated_at = datetime('now') WHERE id = ?`).run(sid, id)
      db.prepare(`UPDATE chat_spaces SET last_used_at = datetime('now') WHERE id = ?`).run(sid)
    }
  }
  if (archived !== undefined) {
    db.prepare(`UPDATE chat_threads SET archived = ?, updated_at = datetime('now') WHERE id = ?`).run(archived ? 1 : 0, id)
  }
  if (preferred_provider !== undefined || preferred_model !== undefined) {
    // Setting model implies setting the matching provider; allow either independently.
    if (preferred_provider !== undefined) {
      db.prepare(`UPDATE chat_threads SET preferred_provider = ?, updated_at = datetime('now') WHERE id = ?`).run(preferred_provider || null, id)
    }
    if (preferred_model !== undefined) {
      db.prepare(`UPDATE chat_threads SET preferred_model = ?, updated_at = datetime('now') WHERE id = ?`).run(preferred_model || null, id)
    }
  }

  const updated = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(id) as ThreadRow
  res.json(shapeThread(updated))
})

// GET /api/chat/threads/:id/context-preview — returns the rendered system prompt
// for this thread. Lets admins see EXACTLY what the model received, which makes
// hallucinations diagnosable in one click.
router.get('/threads/:id/context-preview', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  const thread = db.prepare(`SELECT * FROM chat_threads WHERE id = ? AND user_id = ?`).get(id, userId) as ThreadRow | undefined
  if (!thread) { res.status(404).json({ error: 'Thread not found' }); return }
  const mcp = qbMcpStatus()
  const ari = ariStatus()
  res.json({
    system: buildSystemContext(thread, mcp.enabled),
    space_id: thread.space_id,
    project_id: thread.project_id,
    preferred_provider: thread.preferred_provider,
    preferred_model: thread.preferred_model,
    openclaw_session_key: thread.openclaw_session_key,
    mcp,
    ari,
  })
})

// DELETE /api/chat/threads/:id
router.delete('/threads/:id', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  const t = db.prepare(`SELECT id FROM chat_threads WHERE id = ? AND user_id = ?`).get(id, userId)
  if (!t) { res.status(404).json({ error: 'Thread not found' }); return }
  db.prepare(`DELETE FROM chat_threads WHERE id = ?`).run(id)
  res.json({ ok: true })
})

// POST /api/chat/threads/:id/messages — send a user message, get assistant reply
// Non-streaming v1: optimistic UI on the client + typing indicator while we wait.
const MAX_HISTORY = 20  // recent message turns sent back to the model

router.post('/threads/:id/messages', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  const thread = db.prepare(`SELECT * FROM chat_threads WHERE id = ? AND user_id = ?`).get(id, userId) as ThreadRow | undefined
  if (!thread) { res.status(404).json({ error: 'Thread not found' }); return }

  const { content, prefer_provider, model, notify } = req.body as { content?: string; prefer_provider?: 'anthropic' | 'openai' | 'ollama'; model?: string; notify?: boolean }
  const text = (content || '').trim()
  if (!text) { res.status(400).json({ error: 'content is required' }); return }
  if (text.length > 8000) { res.status(400).json({ error: 'Message too long (8000 char max)' }); return }

  // 1. Persist the user message immediately so the conversation is durable
  //    even if the LLM call fails.
  const userInsert = db.prepare(
    `INSERT INTO chat_messages (thread_id, role, content) VALUES (?, 'user', ?)`
  ).run(id, text)
  const userMsgId = Number(userInsert.lastInsertRowid)
  db.prepare(`UPDATE chat_threads SET last_message_at = datetime('now') WHERE id = ?`).run(id)

  // 2. Auto-title the thread on its first user message — but only for general
  //    threads. Threads inside a Space inherit the space name as their title
  //    (set when the space was attached) and shouldn't be overwritten by
  //    the first message.
  const messageCount = (db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?`).get(id) as { n: number }).n
  if (messageCount === 1 && !thread.space_id && (thread.title === 'New chat' || !thread.title)) {
    const derived = text.slice(0, 60).replace(/\s+/g, ' ').trim()
    db.prepare(`UPDATE chat_threads SET title = ? WHERE id = ?`).run(derived, id)
  }
  if (thread.space_id) {
    db.prepare(`UPDATE chat_spaces SET last_used_at = datetime('now') WHERE id = ?`).run(thread.space_id)
  }

  // 2b. Resolve which project (if any) this thread is bound to. Project-attached
  //     threads are eligible for Ari dispatch; general threads stay on the
  //     local-LLM + QB MCP path.
  let projectIdForThread: number | null = null
  if (thread.space_id) {
    const space = db.prepare(`SELECT project_id FROM chat_spaces WHERE id = ?`).get(thread.space_id) as { project_id: number } | undefined
    if (space) projectIdForThread = space.project_id
  }
  if (!projectIdForThread && thread.project_id) projectIdForThread = thread.project_id

  // 3. Insert a PENDING assistant message and return immediately. The real
  //    Ari/LLM work runs in the background (runAssistantCompletion) and flips
  //    this row to 'completed' / 'failed'. This frees the HTTP request from the
  //    multi-minute round-trip and lets us ping the user when it lands.
  const pendingInsert = db.prepare(
    `INSERT INTO chat_messages (thread_id, role, content, provider, status)
     VALUES (?, 'assistant', '', ?, 'pending')`
  ).run(id, ariStatus().enabled ? 'ari' : null)
  const assistantMsgId = Number(pendingInsert.lastInsertRowid)

  const userMsg = db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(userMsgId) as MessageRow
  const pendingMsg = db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(assistantMsgId) as MessageRow
  const updatedThread = db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(id) as ThreadRow

  res.json({
    ok: true,
    user_message: shapeMessage(userMsg),
    assistant_message: shapeMessage(pendingMsg),
    thread: shapeThread(updatedThread),
  })

  // Fire-and-forget. The runner catches its own errors and writes them to the
  // message row, so a rejection here would be a bug — guard anyway.
  void runAssistantCompletion({
    thread,
    assistantMsgId,
    userId,
    userEmail: req.user!.email,
    userRoles: req.user!.roles,
    text,
    projectIdForThread,
    preferProvider: prefer_provider || (thread.preferred_provider as ProviderId | null) || undefined,
    model: model || thread.preferred_model || undefined,
    notify: notify === true,
  }).catch(e => console.error('[chat] runAssistantCompletion rejected:', e))
})

// Background runner — does the actual Ari dispatch (or local-LLM fallback for
// dev where Ari isn't configured) for a pending assistant message, flips the
// row to completed/failed, and records a chat_complete notification. Never
// throws: any failure is written into the message row so the user sees it.
async function runAssistantCompletion(opts: {
  thread: ThreadRow
  assistantMsgId: number
  userId: number
  userEmail: string
  userRoles: string[]
  text: string
  projectIdForThread: number | null
  preferProvider?: ProviderId
  model?: string
  notify: boolean
}): Promise<void> {
  const { thread, assistantMsgId, userId, userEmail, userRoles, text, projectIdForThread, notify } = opts
  const id = thread.id
  try {
    // Ari path — every thread when the shim is enabled.
    if (ariStatus().enabled) {
      let sessionKey = thread.openclaw_session_key
      if (!sessionKey) {
        sessionKey = `qbspa-thread-${id}`
        db.prepare(`UPDATE chat_threads SET openclaw_session_key = ? WHERE id = ?`).run(sessionKey, id)
      }
      const ari = await dispatchToAri({
        workspace: workspaceForProjectThread(projectIdForThread),
        content: text,
        sessionKey,
        actor: { email: userEmail, roles: userRoles, project_id: projectIdForThread },
      })
      if (ari.ok) {
        finalizeMessage({
          assistantMsgId, threadId: id, userId, notify,
          status: 'completed', content: ari.content, provider: 'ari',
          model: workspaceForProjectThread(projectIdForThread),
          tokens_in: ari.tokens_in ?? 0, tokens_out: ari.tokens_out ?? 0,
        })
        return
      }
      // Ari failed. We deliberately do NOT fall back to the local LLM — it has
      // none of Ari's context, so it would hallucinate. Honest notice instead.
      console.warn('[ari] dispatch failed:', ari.reason, ari.error)
      finalizeMessage({
        assistantMsgId, threadId: id, userId, notify,
        status: 'failed', provider: 'ari',
        content: "Ari isn't responding right now. Please try again in a moment — if it keeps happening, contact your admin.",
        error: `ari_unavailable (${ari.reason}): ${ari.error}`,
      })
      return
    }

    // Local LLM path — only when Ari is NOT configured at all (e.g. local dev
    // without ARI_SHIM_URL). Exclude the empty pending row from history.
    const qbTools = await getQbTools()
    const mcpEnabled = qbTools.length > 0
    const history = db.prepare(
      `SELECT role, content FROM chat_messages WHERE thread_id = ? AND id < ? AND content != '' ORDER BY id DESC LIMIT ?`
    ).all(id, assistantMsgId, MAX_HISTORY) as Array<{ role: string; content: string }>
    history.reverse()
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemContext(thread, mcpEnabled) },
      ...history.map(h => ({ role: h.role as ChatMessage['role'], content: h.content })),
    ]
    const llm = await callUserLlm({
      userId,
      feature: 'chatbot',
      messages,
      preferProvider: opts.preferProvider,
      model: opts.model,
      maxOutputTokens: 800,
      temperature: 0.1,
      ...(mcpEnabled ? { tools: qbTools, executeTool: callQbTool } : {}),
    })
    if (!llm.ok) {
      finalizeMessage({
        assistantMsgId, threadId: id, userId, notify,
        status: 'failed', content: `(${llm.reason}) ${llm.error}`, error: llm.error,
      })
      return
    }
    finalizeMessage({
      assistantMsgId, threadId: id, userId, notify,
      status: 'completed', content: llm.output, provider: llm.provider, model: llm.model,
      tokens_in: llm.tokens_in, tokens_out: llm.tokens_out, cost_cents: llm.cost_cents,
      used_own_key: llm.used_own_key,
      tool_calls_json: llm.tool_calls.length ? JSON.stringify(llm.tool_calls) : null,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[chat] completion runner crashed:', msg)
    finalizeMessage({
      assistantMsgId, threadId: id, userId, notify,
      status: 'failed', content: 'Something went wrong generating a reply. Please try again.', error: msg,
    })
  }
}

// Write the final content into the pending assistant row and drop a
// chat_complete notification. The notification always lands (collapsed
// per-thread while unread) so both "notify me" and auto-notify-when-away work;
// the client acks (marks read) when it showed the answer inline without opt-in.
function finalizeMessage(opts: {
  assistantMsgId: number
  threadId: number
  userId: number
  notify: boolean
  status: 'completed' | 'failed'
  content: string
  provider?: string | null
  model?: string | null
  tokens_in?: number
  tokens_out?: number
  cost_cents?: number
  used_own_key?: boolean
  tool_calls_json?: string | null
  error?: string | null
}): void {
  db.prepare(
    `UPDATE chat_messages
       SET content = ?, provider = ?, model = ?, tokens_in = ?, tokens_out = ?,
           cost_cents = ?, used_own_key = ?, tool_calls_json = ?, error = ?, status = ?
     WHERE id = ?`
  ).run(
    opts.content, opts.provider ?? null, opts.model ?? null,
    opts.tokens_in ?? 0, opts.tokens_out ?? 0, opts.cost_cents ?? 0,
    opts.used_own_key ? 1 : 0, opts.tool_calls_json ?? null, opts.error ?? null,
    opts.status, opts.assistantMsgId,
  )
  db.prepare(`UPDATE chat_threads SET last_message_at = datetime('now') WHERE id = ?`).run(opts.threadId)
  try {
    const preview = opts.content.replace(/\s+/g, ' ').trim().slice(0, 90)
    notifyChatComplete({
      userId: opts.userId,
      threadId: opts.threadId,
      title: opts.status === 'failed' ? 'Ari couldn’t answer your question' : 'Ari answered your question',
      body: preview || null,
    })
  } catch (e) {
    console.warn('[chat] notification insert failed:', e instanceof Error ? e.message : e)
  }
}

// POST /api/chat/threads/:id/ack — mark this thread's unread chat_complete
// notifications read. The client calls this when it has shown the completed
// answer inline and the user didn't opt into a ping, keeping the bell quiet.
router.post('/threads/:id/ack', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const id = parseInt(String(req.params['id']), 10)
  db.prepare(
    `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND type = 'chat_complete' AND link = ? AND is_read = 0`
  ).run(userId, `/chat?thread=${id}`)
  res.json({ ok: true })
})

// GET /api/chat/unread-threads — thread ids that currently have an unread bot
// response, derived from unread chat_complete notifications. Drives the red
// unread dots in the chat sidebar so users can clear them without the bell.
router.get('/unread-threads', (req: Request, res: Response): void => {
  const userId = req.user!.userId
  const rows = db.prepare(
    `SELECT link FROM notifications WHERE user_id = ? AND type = 'chat_complete' AND is_read = 0`
  ).all(userId) as Array<{ link: string | null }>
  const threadIds = rows
    .map(r => { const m = /thread=(\d+)/.exec(r.link || ''); return m ? parseInt(m[1], 10) : null })
    .filter((x): x is number => x != null)
  res.json({ threadIds })
})

// GET /api/chat/mcp-probe — one-shot diagnostic for the QuickBase MCP wiring.
// Reports what the chatbot route sees: env config, tool list, and a small
// live call against `describe_realm` (truncated). When something's off, this
// is the fastest way to tell whether the issue is config, networking, or the
// MCP server itself, without touching the chat flow.
//
// Auth-gated like everything under /api/chat — anyone signed into the portal
// can hit it. Doesn't leak the token; only reports whether one is configured.
router.get('/mcp-probe', async (_req: Request, res: Response): Promise<void> => {
  const status = qbMcpStatus()
  const out: Record<string, unknown> = {
    status,
    tools_count: 0,
    tool_names: [] as string[],
    sample_call: null as null | { tool: string; ok: boolean; excerpt?: string; error?: string },
  }

  if (!status.enabled) {
    out['hint'] = 'QB_MCP_URL is not set on this service. Add it on Railway → qb-spa → Variables and redeploy.'
    res.json(out)
    return
  }

  try {
    const tools = await getQbTools()
    out['tools_count'] = tools.length
    out['tool_names'] = tools.map(t => t.name)
    if (tools.length === 0) {
      out['hint'] = 'MCP is configured but listTools() returned empty — usually means the server is unreachable from this container (DNS / port / firewall), the bearer is wrong (401), or the server errored. Check Railway → qb-spa → Logs for "[qb-mcp]" lines.'
      res.json(out)
      return
    }

    // Pick `describe_realm` if present (cheapest discovery call); otherwise the
    // first tool — just to confirm a real round-trip works end-to-end.
    const probeTool = tools.find(t => t.name === 'describe_realm') || tools[0]!
    try {
      const result = await callQbTool(probeTool.name, {})
      out['sample_call'] = {
        tool: probeTool.name,
        ok: true,
        excerpt: result.slice(0, 400) + (result.length > 400 ? '…' : ''),
      }
    } catch (e) {
      out['sample_call'] = {
        tool: probeTool.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  } catch (e) {
    out['error'] = e instanceof Error ? e.message : String(e)
    out['hint'] = 'Failed to list MCP tools. See message above; check Railway logs for a "[qb-mcp]" warning.'
  }

  res.json(out)
})

// GET /api/chat/quota — combined view of the user's monthly cap + per-provider rate-limit snapshots
router.get('/quota', (req: Request, res: Response): void => {
  const userId = req.user!.userId

  const monthStart = `datetime('now', 'start of month')`
  const agentSpend = (db.prepare(
    `SELECT COALESCE(SUM(cost_cents),0) AS c FROM agent_runs WHERE user_id = ? AND started_at >= ${monthStart}`
  ).get(userId) as { c: number }).c
  const ledgerSpend = db.prepare(
    `SELECT COALESCE(SUM(cost_cents),0) AS total,
            COALESCE(SUM(CASE WHEN used_own_key=0 THEN cost_cents ELSE 0 END),0) AS platform
       FROM user_llm_usage WHERE user_id = ? AND created_at >= ${monthStart}`
  ).get(userId) as { total: number; platform: number }

  const budget = db.prepare(`SELECT monthly_cap_cents, byok_bypasses_cap FROM user_budgets WHERE user_id = ?`).get(userId) as { monthly_cap_cents: number | null; byok_bypasses_cap: number } | undefined
  const cap = budget?.monthly_cap_cents ?? null
  const bypassByok = (budget?.byok_bypasses_cap ?? 1) === 1
  const counted = agentSpend + (bypassByok ? ledgerSpend.platform : ledgerSpend.total)

  const providers: Record<string, unknown> = {}
  for (const p of ['anthropic', 'openai', 'ollama'] as ProviderId[]) {
    const snap = getSnapshot(userId, p)
    if (snap) providers[p] = snap
  }

  res.json({
    cap_cents: cap,
    spent_cents: counted,
    cap_pct_used: cap && cap > 0 ? Math.min(100, Math.round((counted / cap) * 100)) : null,
    byok_bypasses_cap: bypassByok,
    providers,
  })
})

// GET /api/chat/models — what models the user can pick from. Combines hardcoded
// Anthropic/OpenAI lists (gated by whether the user has any key for that provider)
// with the user's actual Ollama model list (fetched from their cloud account).
const ANTHROPIC_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', tier: 'fast' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'balanced' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'powerful' },
]
const OPENAI_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'fast' },
  { id: 'gpt-4o', label: 'GPT-4o', tier: 'balanced' },
]

function hasProviderAccess(userId: number, provider: ProviderId): { available: boolean; usingOwnKey: boolean } {
  const own = getDefaultKeyFor(userId, provider)
  if (own) return { available: true, usingOwnKey: true }
  if (provider === 'anthropic' && process.env['ANTHROPIC_API_KEY']) return { available: true, usingOwnKey: false }
  if (provider === 'openai' && process.env['OPENAI_API_KEY']) return { available: true, usingOwnKey: false }
  return { available: false, usingOwnKey: false }
}

router.get('/models', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId
  const out: Array<{ provider: ProviderId; provider_label: string; using_own_key: boolean; models: Array<{ id: string; label: string; tier?: string }> }> = []

  for (const provider of ['anthropic', 'openai'] as ProviderId[]) {
    const access = hasProviderAccess(userId, provider)
    if (!access.available) continue
    out.push({
      provider,
      provider_label: provider === 'anthropic' ? 'Anthropic' : 'OpenAI',
      using_own_key: access.usingOwnKey,
      models: provider === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS,
    })
  }

  // Ollama: dynamic. Skip if no key.
  const ollamaKey = getDefaultKeyFor(userId, 'ollama')
  if (ollamaKey) {
    const base = (ollamaKey.baseUrl || 'https://ollama.com').replace(/\/+$/, '')
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8_000)
      const r = await fetch(`${base}/api/tags`, {
        headers: { 'Authorization': `Bearer ${ollamaKey.apiKey}`, 'Accept': 'application/json' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (r.ok) {
        const data = await r.json().catch(() => ({})) as { models?: Array<{ name?: string; model?: string }> }
        const models = (data.models || [])
          .map(m => String(m.name || m.model || ''))
          .filter(Boolean)
          .slice(0, 50)
          .map(name => ({ id: name, label: name }))
        out.push({
          provider: 'ollama',
          provider_label: 'Ollama',
          using_own_key: true,
          models,
        })
      }
    } catch { /* offline / timeout — just don't surface ollama */ }
  }

  res.json({ providers: out })
})

// GET /api/chat/projects/search?q=... — minimal project picker for the chat composer.
// IMPORTANT: this MUST be registered BEFORE /projects/:id below, otherwise Express
// matches "search" as the :id and returns 400. Express matches in declaration order.
router.get('/projects/search', (req: Request, res: Response): void => {
  const q = (req.query['q'] as string || '').trim().toLowerCase()
  if (!q || q.length < 2) { res.json({ projects: [] }); return }
  const rows = db.prepare(
    `SELECT record_id, customer_name, status, state
       FROM project_cache
      WHERE LOWER(customer_name) LIKE ? OR CAST(record_id AS TEXT) LIKE ?
      ORDER BY customer_name COLLATE NOCASE
      LIMIT 25`
  ).all(`%${q}%`, `%${q}%`) as Array<{ record_id: number; customer_name: string | null; status: string | null; state: string | null }>
  res.json({ projects: rows })
})

// GET /api/chat/projects/:id — minimal project preview used by ProjectHome
// to render the context block (status, state, milestones, coordinator, etc.)
router.get('/projects/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params['id']), 10)
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'Invalid id' }); return }
  const project = getProject(id)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  res.json({
    record_id: project.record_id,
    customer_name: project.customer_name,
    status: project.status,
    state: project.state,
    system_size_kw: project.system_size_kw,
    sales_date: project.sales_date,
    coordinator: project.coordinator,
    closer: project.closer,
    lender: project.lender,
  })
})

export { router as chatRouter }
