// ─── Anthropic tool-use loop (reference provider adapter) ─────────────
// One of several ways to drive the provider-neutral toolkit in
// ./tools/dataTools.ts. This is the ANTHROPIC adapter: it runs the
// agentic round-trip — the model calls read-only tools, we resolve them
// via the shared dispatcher, feed results back, repeat until a final
// answer. An OpenAI loop or the MCP server (./tools/mcpServer.ts) are
// parallel front-ends over the SAME TOOL_SPECS + executeDataTool.
//
// holdClassifier.ts and feedbackTriage.ts today do single-shot prompt-
// stuffing with no tools; this is the missing agentic loop they (and the
// seeded role tasks) can adopt. Tools stay read-only by construction;
// write/outreach actions remain behind the agent_approvals gate.

import Anthropic from '@anthropic-ai/sdk'

export interface RunWithToolsOptions {
  system: string
  user: string
  tools: Anthropic.Tool[]
  // Synchronous dispatcher: (name, input) -> result object. A throw is
  // surfaced to the model as an is_error tool_result so it can recover.
  executeTool: (name: string, input: Record<string, unknown>) => unknown
  model?: string
  maxTokens?: number
  // Hard cap on tool round-trips before we stop and return what we have.
  maxTurns?: number
  apiKey?: string
  // Optional observer — fires on each tool call for logging / tracing.
  onToolCall?: (name: string, input: Record<string, unknown>, result: unknown) => void
}

export interface RunWithToolsResult {
  text: string
  turns: number
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
  tokensIn: number
  tokensOut: number
  stoppedEarly: boolean
}

const DEFAULT_MODEL = process.env['AGENT_TOOLS_MODEL'] || 'claude-sonnet-4-6'

export async function runAgentWithTools(opts: RunWithToolsOptions): Promise<RunWithToolsResult> {
  const apiKey = opts.apiKey || process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })
  const model = opts.model || DEFAULT_MODEL
  const maxTurns = opts.maxTurns ?? 8

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.user }]
  const toolCalls: RunWithToolsResult['toolCalls'] = []
  let tokensIn = 0
  let tokensOut = 0
  let stoppedEarly = false

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      tools: opts.tools,
      messages,
    })

    tokensIn +=
      (response.usage.input_tokens || 0) +
      (response.usage.cache_creation_input_tokens || 0) +
      (response.usage.cache_read_input_tokens || 0)
    tokensOut += response.usage.output_tokens || 0

    // Record the assistant turn verbatim so the next request has the
    // tool_use blocks the tool_results refer to.
    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
      return { text, turns: turn, toolCalls, tokensIn, tokensOut, stoppedEarly }
    }

    // Resolve every tool_use block in this turn into a tool_result.
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const input = (block.input ?? {}) as Record<string, unknown>
      toolCalls.push({ name: block.name, input })
      try {
        const result = opts.executeTool(block.name, input)
        opts.onToolCall?.(block.name, input, result)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${message}`,
          is_error: true,
        })
      }
    }
    messages.push({ role: 'user', content: toolResults })
  }

  // Ran out of turns without a final text answer.
  stoppedEarly = true
  return {
    text: '(stopped: reached max tool-use turns without a final answer)',
    turns: maxTurns,
    toolCalls,
    tokensIn,
    tokensOut,
    stoppedEarly,
  }
}
