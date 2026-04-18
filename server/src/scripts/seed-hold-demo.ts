import db from '../db'

const DEMO_CLASSIFICATIONS = [
  {
    category: 'customer',
    subcategory: 'Lightreach stipulation — contract review pending',
    confidence: 0.82,
    one_line_reason: 'Lightreach stipulation blocks funding; customer must complete contract review before release',
    evidence_note_ids: [269858, 269579],
    last_movement_days: 1,
    days_on_hold: 2,
    suggested_next_action: 'Schedule customer walkthrough call; confirm stip closure with Lightreach desk',
  },
  {
    category: 'utility',
    subcategory: 'NEM rejection — load calc mismatch',
    confidence: 0.93,
    one_line_reason: 'PG&E rejected NEM over load calc mismatch; design hasn\'t returned revised calc in 4d',
    evidence_note_ids: [],
    last_movement_days: 4,
    days_on_hold: 6,
    suggested_next_action: 'Escalate design team for revised load calc; set internal 48h SLA',
  },
  {
    category: 'HOA',
    subcategory: 'ARC resubmission pending',
    confidence: 0.91,
    one_line_reason: 'HOA requested aerial resubmission 4/5; customer unreachable to confirm docs',
    evidence_note_ids: [],
    last_movement_days: 3,
    days_on_hold: 12,
    suggested_next_action: 'Resubmit aerial to HOA; parallel outreach to customer for doc confirmation',
  },
  {
    category: 'finance',
    subcategory: 'Goodleap M2 decision delay',
    confidence: 0.87,
    one_line_reason: 'Goodleap M2 submitted 4/1, no decision in 14d despite 4/13 follow-up',
    evidence_note_ids: [],
    last_movement_days: 2,
    days_on_hold: 14,
    suggested_next_action: 'Phone-escalate Goodleap funding desk; CC regional ops mgr',
  },
  {
    category: 'permitting',
    subcategory: 'AHJ plan review — revisions requested',
    confidence: 0.88,
    one_line_reason: 'City plan reviewer requested structural annotations; revised plans pending design',
    evidence_note_ids: [],
    last_movement_days: 5,
    days_on_hold: 9,
    suggested_next_action: 'Push design for annotated plans; aim to resubmit by Friday',
  },
  {
    category: 'customer',
    subcategory: 'change order — battery add',
    confidence: 0.84,
    one_line_reason: 'Change order for battery add; signed, lender re-amortizing, design refresh pending',
    evidence_note_ids: [],
    last_movement_days: 1,
    days_on_hold: 3,
    suggested_next_action: 'Kick off design refresh; confirm lender re-amort complete',
  },
  {
    category: 'design',
    subcategory: 'structural redesign required',
    confidence: 0.79,
    one_line_reason: 'Roof survey flagged truss spacing; engineer returning revised attachment plan',
    evidence_note_ids: [],
    last_movement_days: 2,
    days_on_hold: 7,
    suggested_next_action: 'Await engineer revision; notify customer of 3-5d delay',
  },
  {
    category: 'customer',
    subcategory: 'unresponsive — blocking HOA signature',
    confidence: 0.71,
    one_line_reason: 'HOA packet blocked on customer signature; 18d unresponsive despite 3 calls + 2 texts',
    evidence_note_ids: [],
    last_movement_days: 18,
    days_on_hold: 22,
    suggested_next_action: 'Escalate to closer; if no response in 7d trigger cancellation protocol',
  },
  {
    category: 'utility',
    subcategory: 'PTO — utility special requirements',
    confidence: 0.86,
    one_line_reason: 'FPL required additional disconnect switch inspection; waiting on utility scheduler',
    evidence_note_ids: [],
    last_movement_days: 6,
    days_on_hold: 11,
    suggested_next_action: 'Weekly follow-up to FPL PTO desk; flag to regional utility liaison',
  },
  {
    category: 'internal',
    subcategory: 'CAD queue backlog',
    confidence: 0.76,
    one_line_reason: 'Design in CAD queue for 9d; no design lead assignment yet',
    evidence_note_ids: [],
    last_movement_days: 9,
    days_on_hold: 9,
    suggested_next_action: 'Escalate to CAD manager for assignment; flag in daily ops stand-up',
  },
  {
    category: 'site',
    subcategory: 'MPU upgrade required',
    confidence: 0.85,
    one_line_reason: 'Survey found panel upgrade needed; customer weighing $ cost vs. scope',
    evidence_note_ids: [],
    last_movement_days: 4,
    days_on_hold: 6,
    suggested_next_action: 'Provide customer with 2 MPU quotes; decision deadline in 5d',
  },
  {
    category: 'HOA',
    subcategory: 'ARC decision pending',
    confidence: 0.92,
    one_line_reason: 'ARC packet submitted 3/20; standard 30d review window still open',
    evidence_note_ids: [],
    last_movement_days: 10,
    days_on_hold: 25,
    suggested_next_action: 'No action — track; nudge HOA if no response by 4/20',
  },
  {
    category: 'finance',
    subcategory: 'credit recheck required',
    confidence: 0.81,
    one_line_reason: 'Lender requested fresh credit pull; customer consent received 2d ago',
    evidence_note_ids: [],
    last_movement_days: 2,
    days_on_hold: 4,
    suggested_next_action: 'Submit fresh pull to lender; expected 2-3d turnaround',
  },
  {
    category: 'other',
    subcategory: 'pending resale transfer',
    confidence: 0.68,
    one_line_reason: 'Customer listed home for sale; resale flagged, waiting on buyer assignment',
    evidence_note_ids: [],
    last_movement_days: 11,
    days_on_hold: 16,
    suggested_next_action: 'Confirm resale path with ops; pause outreach until buyer identified',
  },
  {
    category: 'customer',
    subcategory: 'doc collection — proof of ownership',
    confidence: 0.83,
    one_line_reason: 'Lender requires title doc; customer promised delivery 2d ago, not yet received',
    evidence_note_ids: [],
    last_movement_days: 2,
    days_on_hold: 5,
    suggested_next_action: 'Follow up with customer for title; offer secure upload link',
  },
]

function main() {
  const holds = db.prepare(
    `SELECT record_id FROM project_cache WHERE status LIKE '%Hold%' ORDER BY record_id DESC LIMIT 25`
  ).all() as Array<{ record_id: number }>

  console.log(`Found ${holds.length} hold projects. Seeding fake classifications...`)

  const run = db.prepare(
    `INSERT INTO agent_runs (agent, trigger, status, finished_at, duration_ms, projects_scanned, projects_classified, model, error)
     VALUES ('hold-classifier', 'manual', 'completed', datetime('now'), 2500, ?, ?, 'demo-seed', NULL)`
  ).run(holds.length, holds.length)
  const runId = Number(run.lastInsertRowid)

  const upsert = db.prepare(
    `INSERT INTO agent_outputs (agent, project_id, run_id, payload_json, input_hash, generated_at)
     VALUES ('hold-classifier', ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(agent, project_id) DO UPDATE SET
       run_id=excluded.run_id,
       payload_json=excluded.payload_json,
       input_hash=excluded.input_hash,
       generated_at=excluded.generated_at`
  )

  holds.forEach((h, i) => {
    const cls = DEMO_CLASSIFICATIONS[i % DEMO_CLASSIFICATIONS.length]
    upsert.run(h.record_id, runId, JSON.stringify(cls), `demo-${h.record_id}`)
  })

  console.log(`Seeded ${holds.length} classifications under run_id ${runId}.`)
  console.log('Clear with: DELETE FROM agent_outputs WHERE input_hash LIKE "demo-%";')
}

main()
