// ─── KPI Toolkit demo / smoke test ────────────────────────────────────
// Proves the provider-neutral toolkit end-to-end against the real local
// project_cache.
//
//   Part 1 (no API key): list + compute every KPI from the cache. This
//   validates the registry and dispatcher — the portable core every
//   provider shares.
//
//   Part 2 (if ANTHROPIC_API_KEY is set): drive the tools through the
//   Anthropic agentic loop so you can watch a model call get_kpi /
//   query_projects and reason over real data. The OpenAI adapter and the
//   MCP server are parallel front-ends over the same core.
//
// Run:  npx tsx src/scripts/kpi-agent-demo.ts
// (from the server/ directory, so the SQLite path resolves like the app)

// Importing the projects route ensures project_cache exists/refreshes the
// same way the running server creates it.
import '../routes/projects'

import { listMetrics, computeMetric } from '../agents/kpi/registry'
import { TOOL_SPECS, toAnthropicTools, executeDataTool } from '../agents/tools/dataTools'
import { runAgentWithTools } from '../agents/runWithTools'

function part1bDomainTools(): void {
  console.log('\n=== Part 1b: Domain digest tools ===\n')
  const calls: Array<[string, Record<string, unknown>]> = [
    ['get_funding_status', { milestone: 'M2' }],
    ['get_comms_stats', { window_days: 30 }],
    ['get_tickets', { top: 5 }],
    ['get_breakdown', { dimension: 'state' }],
    ['get_schedule', { task: 'install', window: 'next_7_days' }],
  ]
  for (const [name, input] of calls) {
    try {
      const r = executeDataTool(name, input) as Record<string, unknown>
      console.log(`• ${name}(${JSON.stringify(input)})`)
      console.log(`    ${JSON.stringify(r).slice(0, 220)}…`)
    } catch (err) {
      console.log(`• ${name}  ERROR: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function part1ComputeAllKpis(): void {
  console.log('\n=== Part 1: KPIs from local project_cache (no LLM) ===\n')
  const metrics = listMetrics()
  console.log(`Registry exposes ${metrics.length} KPIs and ${TOOL_SPECS.length} agent tools.\n`)

  for (const m of metrics) {
    try {
      const r = computeMetric(m.slug, { sampleLimit: 3 })
      const age = r.avg_days_in_stage == null ? '' : `  avg ${r.avg_days_in_stage}d in stage`
      console.log(`• ${r.label.padEnd(34)} ${String(r.value).padStart(5)} ${r.unit}${age}`)
      for (const s of r.sample) {
        const days = s.days_in_stage == null ? '' : ` (${s.days_in_stage}d)`
        console.log(`      ↳ #${s.record_id} ${s.customer_name ?? '—'} · ${s.coordinator ?? 'unassigned'}${days}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`• ${m.label.padEnd(34)}  ERROR: ${msg}`)
    }
  }
}

async function part2AgentLoop(): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.log('\n=== Part 2 skipped (set ANTHROPIC_API_KEY to run the live agent loop) ===\n')
    return
  }

  console.log('\n=== Part 2: Anthropic agent driving the toolkit ===\n')
  const system =
    'You are an operations analyst for a residential solar installer. ' +
    'Use the available tools to inspect real project data before answering. ' +
    'Discover KPIs with list_kpis, then drill in with get_kpi. ' +
    'Always ground claims in tool results and cite specific project record_ids.'
  const question =
    'Which funnel stage has the worst backlog right now? Give the count and ' +
    'average days-in-stage, and name 3 specific projects (record_id + coordinator) to chase first.'

  const result = await runAgentWithTools({
    system,
    user: question,
    tools: toAnthropicTools(),
    executeTool: executeDataTool,
    onToolCall: (name, input) => console.log(`  → tool: ${name}(${JSON.stringify(input)})`),
  })

  console.log(`\n--- Answer (${result.turns} turns, ${result.toolCalls.length} tool calls, ` +
    `${result.tokensIn} in / ${result.tokensOut} out) ---\n`)
  console.log(result.text)
}

async function main(): Promise<void> {
  part1ComputeAllKpis()
  part1bDomainTools()
  await part2AgentLoop()
  console.log('\nMCP front-end: npx tsx src/agents/tools/mcpServer.ts  (use from any MCP client)\n')
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
