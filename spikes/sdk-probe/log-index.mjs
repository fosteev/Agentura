// Оглавление логов пробы: номер строки → короткая метка. node spikes/sdk-probe/log-index.mjs > index.txt
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = join(dirname(fileURLToPath(import.meta.url)), 'logs')
for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
  console.log('## ' + f)
  const L = readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean).map((l, i) => [i + 1, JSON.parse(l)])
  let lastKey, run = 0
  const out = (i, s) => console.log(`${i} ${s}`)
  for (const [i, m] of L) {
    if (m.type === 'stream_event') {
      const e = m.event
      if (e.type === 'message_start') out(i, `se message_start out=${e.message.usage.output_tokens} ttft=${m.ttft_ms} td=${m.thinking_display}`)
      else if (e.type === 'message_delta') out(i, `se message_delta out=${e.usage.output_tokens} think=${e.usage.output_tokens_details?.thinking_tokens} stop=${e.delta.stop_reason}`)
      else if (e.type === 'content_block_start') out(i, `se block_start ${e.content_block.type}${e.content_block.name ? ':' + e.content_block.name : ''}`)
      else if (e.type === 'content_block_delta') { const k = e.delta.type; if (k !== lastKey) { out(i, `se delta ${k}${k === 'thinking_delta' ? ` len=${e.delta.thinking.length} est=${e.delta.estimated_tokens}` : ''}`) } lastKey = k; continue }
      lastKey = undefined; continue
    }
    lastKey = undefined
    if (m.type === 'probe') {
      if (m.kind === 'control') out(i, `P ${m.method}(${JSON.stringify(m.args).slice(1, -1).slice(0, 40)}) ${m.ok ? 'ok' : 'FAIL ' + m.error} ${m.ms}ms ${m.result && typeof m.result === 'object' ? 'keys=' + Object.keys(m.result).join(',').slice(0, 260) : m.result}`)
      else if (m.kind === 'canUseTool') out(i, `P canUseTool ${m.toolName} nth=${m.nth} sugg=${JSON.stringify((m.options.suggestions ?? []).map((s) => s.type + '>' + s.destination + (s.rules ? ':' + s.rules.map((r) => r.toolName + '(' + (r.ruleContent ?? '') + ')') : s.mode ?? '')))} agentID=${m.options.agentID ?? '-'} blocked=${m.options.blockedPath ? 'y' : '-'} reason=${m.options.decisionReason ?? '-'} rui=${m.options.requiresUserInteraction ?? '-'}`)
      else if (m.kind === 'canUseTool_result') out(i, `P → ${m.result.behavior} ${m.result.updatedPermissions ? 'perms=' + m.result.updatedPermissions.map((s) => s.type + '>' + s.destination) : ''}${m.result.message ? ' msg' : ''}`)
      else if (m.kind === 'send') out(i, `P send ${m.text.slice(0, 50)}`)
      else if (m.kind === 'summary') out(i, `P summary ${JSON.stringify(m.counts)}`)
      else out(i, `P ${m.kind} ${JSON.stringify(m).slice(0, 330)}`)
    } else if (m.type === 'assistant') out(i, `assistant ${m.message.id.slice(-5)} ${m.message.model.replace('claude-', '')} [${m.message.content.map((c) => c.type === 'thinking' ? `thinking(${c.thinking.length})` : c.type === 'text' ? 'text' : c.name).join(',')}] out=${m.message.usage.output_tokens} in=${m.message.usage.input_tokens}+cr${m.message.usage.cache_read_input_tokens}+cc${m.message.usage.cache_creation_input_tokens} 5m=${m.message.usage.cache_creation?.ephemeral_5m_input_tokens} 1h=${m.message.usage.cache_creation?.ephemeral_1h_input_tokens} ptu=${m.parent_tool_use_id?.slice(-5) ?? '-'}${m.context_usage ? ' CTX' : ''}${m.aborted ? ' aborted' : ''}`)
    else if (m.type === 'user') out(i, `user ${Array.isArray(m.message.content) ? m.message.content.map((c) => c.type + (c.is_error ? '!' : '')).join(',') : 'text:' + m.message.content.slice(0, 50).replace(/\n/g, ' ')} ptu=${m.parent_tool_use_id?.slice(-5) ?? '-'}${m.tool_use_result !== undefined ? ' tur=' + (typeof m.tool_use_result === 'string' ? 'str' : Object.keys(m.tool_use_result).join(',').slice(0, 200)) : ''}${m.isReplay ? ' replay' : ''}${m.isSynthetic ? ' synthetic' : ''}${m.origin ? ' origin=' + JSON.stringify(m.origin).slice(0, 80) : ''}`)
    else if (m.type === 'system') {
      if (m.subtype === 'init') out(i, `init model=${m.model} mode=${m.permissionMode} key=${m.apiKeySource}`)
      else if (m.subtype === 'status') out(i, `status ${m.status} ${m.permissionMode ?? ''} ${m.compact_result ?? ''}`)
      else if (m.subtype === 'thinking_tokens') { if (run++ % 8 === 0) out(i, `thinking_tokens est=${m.estimated_tokens} d=${m.estimated_tokens_delta}`) }
      else { const { type, subtype, uuid, session_id, ...rest } = m; out(i, `sys ${subtype} ${JSON.stringify(rest).slice(0, 420)}`) }
    } else if (m.type === 'rate_limit_event') out(i, `rate_limit ${JSON.stringify(m.rate_limit_info).slice(0, 330)}`)
    else if (m.type === 'result') out(i, `result ${m.subtype} tr=${m.terminal_reason} turns=${m.num_turns} ms=${m.duration_ms} $=${m.total_cost_usd.toFixed(4)} usage.out=${m.usage.output_tokens} mu=${Object.entries(m.modelUsage).map(([k, v]) => k.replace('claude-', '') + ':$' + v.costUSD.toFixed(4) + '/win' + v.contextWindow + '/out' + v.outputTokens).join(' ')} denials=${m.permission_denials.length} origin=${JSON.stringify(m.origin ?? null)} sub=${JSON.stringify(m.subagent_stats?.requested ?? null)}/${m.subagent_stats?.started_in_background}`)
    else out(i, `${m.type} ${JSON.stringify(m).slice(0, 200)}`)
  }
}
