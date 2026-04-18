import 'dotenv/config'
import db from '../db'
import { classifyHoldProject, type HoldProject } from '../agents/holdClassifier'
import { fetchProjectNotes } from '../agents/notesFetcher'

async function main() {
  const projectId = parseInt(process.argv[2] || '', 10)
  if (!projectId) { console.error('Usage: tsx src/scripts/dry-run-hold.ts <project_id>'); process.exit(1) }

  const project = db.prepare(
    `SELECT record_id, customer_name, status, state, system_size_kw, sales_date, lender, coordinator,
            intake_completed, survey_submitted, survey_approved, design_completed,
            nem_submitted, nem_approved, nem_rejected, permit_submitted, permit_approved, permit_rejected,
            install_scheduled, install_completed, inspection_scheduled, inspection_passed,
            pto_submitted, pto_approved
       FROM project_cache WHERE record_id = ?`
  ).get(projectId) as HoldProject | undefined

  if (!project) { console.error(`Project ${projectId} not in cache`); process.exit(2) }

  console.log(`\n== Project ${projectId}: ${project.customer_name ?? '(unnamed)'} ==`)
  console.log(`Status: ${project.status}`)
  console.log(`State:  ${project.state}`)

  console.log(`\n-- Fetching notes from QB (table bsb6bqt3b) --`)
  const notes = await fetchProjectNotes(projectId, 90)
  console.log(`Got ${notes.length} notes in last 90 days`)
  for (const n of notes.slice(0, 10)) {
    console.log(`  [${n.record_id}] ${n.date} | ${n.category} | ${n.note_by}${n.disposition ? ` | ${n.disposition}` : ''}`)
    console.log(`      ${n.text.replace(/\s+/g, ' ').trim().slice(0, 160)}`)
  }
  if (notes.length > 10) console.log(`  ...and ${notes.length - 10} more`)

  if (notes.length === 0) {
    console.log('\n!! Zero notes returned. Either project has none, or note field IDs in notesFetcher.ts are wrong.')
    console.log('   Aborting classification to save tokens.')
    process.exit(3)
  }

  console.log(`\n-- Calling Sonnet --`)
  const result = await classifyHoldProject(project, notes)
  console.log(`\n== Classification ==`)
  console.log(JSON.stringify(result.classification, null, 2))
  console.log(`\n== Run metadata ==`)
  console.log(`Model:       ${result.model}`)
  console.log(`Tokens in:   ${result.tokens_in}`)
  console.log(`Tokens out:  ${result.tokens_out}`)
  console.log(`Cost:        $${(result.cost_cents / 100).toFixed(4)}`)
}

main().catch(err => { console.error(err); process.exit(99) })
