#!/usr/bin/env node
// Этап 0: проба Claude Agent SDK на живом движке (docs/roadmap/02-implementation.md).
//
//   node run.mjs            — все сценарии подряд, бюджет 2 USD на прогон
//   node run.mjs 2 7        — только выбранные (по номеру), расход копится в logs/_ledger.json
//
// Каждый сценарий пишет logs/<сценарий>.jsonl: сообщения SDK как пришли, по одному в строке,
// вперемешку со строками пробы `{"type":"probe", ...}` (что отправили, что пришло в canUseTool,
// что вернули управляющие методы). Логи — будущие фикстуры тестов адаптера: строки с
// `type: "probe"` при разборе пропускать.
import { getSessionInfo, getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const LOGS = join(HERE, 'logs')
const LEDGER = join(LOGS, '_ledger.json')
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
const BUDGET_USD = 2
const WAIT_MS = 240_000

const README = join(REPO, 'README.md')
const CLAUDE_DIR = join(REPO, '.claude')
const LOCAL_SETTINGS = join(CLAUDE_DIR, 'settings.local.json')
const TMP_FILES = ['.bash-probe.tmp', '.bash-probe-2.tmp', '.write-probe.tmp', '.deny-probe.tmp'].map((f) => join(HERE, f))

/** Что не должно попасть в логи: почта аккаунта и токен. Заполняется по ходу. */
const REDACT = new Set()
const started = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function redact(line) {
  let out = line.replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted-token>')
  for (const secret of REDACT) out = out.split(secret).join('<redacted>')
  return out
}

function openLog(name) {
  const path = join(LOGS, `${name}.jsonl`)
  writeFileSync(path, '')
  const write = (obj) => appendFileSync(path, redact(JSON.stringify(obj)) + '\n')
  return {
    path,
    sdk: write,
    probe: (kind, data = {}) => write({ type: 'probe', kind, t: Date.now() - started, ...data }),
  }
}

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'))
  } catch {
    return { budgetUsd: BUDGET_USD, spentUsd: 0, scenarios: [] }
  }
}

function spend(name, costUsd, note) {
  const ledger = readLedger()
  ledger.spentUsd = Number((ledger.spentUsd + costUsd).toFixed(6))
  ledger.scenarios.push({ name, costUsd, at: new Date().toISOString(), ...(note ? { note } : {}) })
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n')
}

/** Окружение движка: без ключа API (вход CLI) и без служебных переменных сессии, из которой запущена проба. */
function childEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agentura-sdk-probe/0' }
  delete env.ANTHROPIC_API_KEY
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION)$|^CLAUDE_CODE_/.test(key)) delete env[key]
  }
  return env
}

/** Очередь входящих сообщений — streaming input mode. */
function channel() {
  const items = []
  let wake
  let ended = false
  return {
    push(item) {
      items.push(item)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    iterable: (async function* () {
      for (;;) {
        while (items.length > 0) yield items.shift()
        if (ended) return
        await new Promise((r) => (wake = r))
        wake = undefined
      }
    })(),
  }
}

/** Снимок файлов, которые сценарии правят, и возврат как было. */
function guardFiles() {
  const readme = readFileSync(README)
  const hadDir = existsSync(CLAUDE_DIR)
  const settings = existsSync(LOCAL_SETTINGS) ? readFileSync(LOCAL_SETTINGS) : undefined
  return () => {
    writeFileSync(README, readme)
    if (settings !== undefined) writeFileSync(LOCAL_SETTINGS, settings)
    else rmSync(LOCAL_SETTINGS, { force: true })
    if (!hadDir) rmSync(CLAUDE_DIR, { recursive: true, force: true })
    for (const file of TMP_FILES) rmSync(file, { force: true })
  }
}

/**
 * Один сценарий — одна живая query() с очередью входящих.
 * `body(ctx)` ведёт диалог; `decide` в ctx отвечает на canUseTool (по умолчанию — allow).
 * `baselineUsd` — стоимость, восстановленная из возобновлённой сессии: в расход прогона не идёт.
 */
async function scenario(name, options, body, { baselineUsd = 0 } = {}) {
  const ledger = readLedger()
  const remaining = ledger.budgetUsd - ledger.spentUsd
  const log = openLog(name)
  if (remaining < 0.05) {
    log.probe('skipped', { reason: 'budget', spentUsd: ledger.spentUsd })
    console.log(`— ${name}: пропущен, бюджет исчерпан`)
    return { ok: false }
  }

  const restore = guardFiles()
  const inbox = channel()
  const seen = []
  const listeners = new Set()
  let cursor = 0
  let streamDone = false
  const notify = () => listeners.forEach((fn) => fn())

  const ctx = {
    log,
    seen,
    decide: undefined,
    permissionCalls: [],
    send(text) {
      log.probe('send', { text })
      inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    },
    /** Первое сообщение после уже просмотренных, подходящее под условие. */
    waitFor(label, pred, timeoutMs = WAIT_MS) {
      return new Promise((resolveWait, rejectWait) => {
        const check = () => {
          for (; cursor < seen.length; cursor++) {
            if (pred(seen[cursor])) {
              cleanup()
              resolveWait(seen[cursor++])
              return
            }
          }
          if (streamDone) {
            cleanup()
            rejectWait(new Error(`поток закончился, не дождались: ${label}`))
          }
        }
        const timer = setTimeout(() => {
          cleanup()
          rejectWait(new Error(`таймаут ${timeoutMs} мс: ${label}`))
        }, timeoutMs)
        const cleanup = () => {
          clearTimeout(timer)
          listeners.delete(check)
        }
        listeners.add(check)
        check()
      })
    },
    /** То же, но не двигает курсор и не падает: было ли сообщение среди пришедших/придёт ли за срок. */
    async seenWithin(pred, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hit = seen.find(pred)
        if (hit || streamDone || Date.now() > deadline) return hit
        await sleep(200)
      }
    },
    result: (label = 'result') => ctx.waitFor(label, (m) => m.type === 'result'),
    async turn(text) {
      ctx.send(text)
      return ctx.result(`result на «${text.slice(0, 40)}»`)
    },
    /** Управляющий метод Query: результат или ошибка — строкой пробы. */
    async call(method, ...args) {
      const at = Date.now()
      try {
        const result = await q[method](...args)
        if (result?.account?.email) REDACT.add(result.account.email)
        if (result?.email) REDACT.add(result.email)
        log.probe('control', { method, args, ok: true, ms: Date.now() - at, result: result ?? null })
        return result
      } catch (error) {
        log.probe('control', { method, args, ok: false, ms: Date.now() - at, error: String(error?.message ?? error) })
        return undefined
      }
    },
  }

  const q = query({
    prompt: inbox.iterable,
    options: {
      cwd: REPO,
      env: childEnv(),
      model: SONNET,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Пользовательские настройки не берём: там хуки, MCP и правила разрешений владельца,
      // которые исказили бы canUseTool и раздули контекст.
      settingSources: ['project', 'local'],
      strictMcpConfig: true,
      includePartialMessages: true,
      maxBudgetUsd: Number(remaining.toFixed(2)),
      title: `sdk-probe ${name}`,
      stderr: (data) => log.probe('stderr', { data }),
      canUseTool: async (toolName, input, opts) => {
        const { signal, ...rest } = opts
        const nth = ctx.permissionCalls.filter((c) => c.toolName === toolName).length
        ctx.permissionCalls.push({ toolName, input, opts: rest })
        log.probe('canUseTool', { toolName, nth, input, options: rest, optionKeys: Object.keys(opts) })
        const result = (await ctx.decide?.(toolName, input, rest, nth)) ?? { behavior: 'allow', updatedInput: input }
        log.probe('canUseTool_result', { toolName, toolUseID: rest.toolUseID, result })
        return result
      },
      ...options,
    },
  })
  ctx.q = q

  const pump = (async () => {
    try {
      for await (const message of q) {
        log.sdk(message)
        seen.push(message)
        notify()
      }
    } catch (error) {
      log.probe('stream_error', { error: String(error?.message ?? error) })
    } finally {
      streamDone = true
      notify()
    }
  })()

  let ok = true
  try {
    await body(ctx)
  } catch (error) {
    ok = false
    log.probe('scenario_error', { error: String(error?.message ?? error) })
    console.log(`  ! ${name}: ${error?.message ?? error}`)
  } finally {
    inbox.end()
    await Promise.race([pump, sleep(20_000)])
    try {
      q.close()
    } catch {}
    const plans = [...new Set(ctx.permissionCalls.map((c) => c.input?.planFilePath).filter((p) => typeof p === 'string' && p.startsWith(join(homedir(), '.claude', 'plans') + '/')))]
    for (const plan of plans) rmSync(plan, { force: true })
    log.probe('files_after', {
      removedPlanFiles: plans,
      readmeTail: readFileSync(README, 'utf8').split('\n').slice(-4),
      localSettings: existsSync(LOCAL_SETTINGS) ? readFileSync(LOCAL_SETTINGS, 'utf8') : null,
      tmpFiles: TMP_FILES.filter((f) => existsSync(f)).map((f) => f.slice(HERE.length + 1)),
    })
    restore()
  }

  const results = seen.filter((m) => m.type === 'result')
  const totalCostUsd = results.at(-1)?.total_cost_usd ?? 0
  const costUsd = Math.max(0, totalCostUsd - baselineUsd)
  const counts = {}
  for (const m of seen) {
    const key =
      m.type === 'stream_event'
        ? `stream_event/${m.event?.type}${m.event?.delta?.type ? `/${m.event.delta.type}` : ''}${m.event?.content_block?.type ? `/${m.event.content_block.type}` : ''}`
        : m.subtype
          ? `${m.type}/${m.subtype}`
          : m.type
    counts[key] = (counts[key] ?? 0) + 1
  }
  log.probe('summary', { ok, costUsd, totalCostUsd, baselineUsd, results: results.length, counts })
  spend(name, costUsd)
  console.log(`${ok ? '✓' : '✗'} ${name}: ${seen.length} сообщений, ${results.length} result, ~$${costUsd.toFixed(4)}`)
  return { ok, seen, sessionId: seen.find((m) => m.type === 'system' && m.subtype === 'init')?.session_id, costUsd }
}

const isStatus = (m) => m.type === 'system' && m.subtype === 'status'
const isTextDelta = (m) => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta'

// ── 1. Привет, interrupt на втором ходу, setPermissionMode, setModel, applyFlagSettings ──
const s1 = () =>
  scenario('01-basic-control', { effort: 'low' }, async (ctx) => {
    await ctx.call('initializationResult')
    await ctx.call('accountInfo')
    await ctx.call('supportedModels')
    await ctx.turn('Привет! Ответь одним коротким предложением.')

    ctx.send('Напиши подробное эссе на 600 слов об истории Unix.')
    for (let i = 0; i < 5; i++) await ctx.waitFor('text_delta перед interrupt', isTextDelta)
    await ctx.call('interrupt')
    await ctx.result('result после interrupt')

    await ctx.call('setPermissionMode', 'acceptEdits')
    await ctx.seenWithin((m) => isStatus(m) && m.permissionMode === 'acceptEdits', 3000)
    await ctx.call('setPermissionMode', 'default')
    await ctx.call('setModel', OPUS)
    await ctx.call('applyFlagSettings', { effortLevel: 'high' })
    await ctx.turn('Какая ты модель? Ответь одним коротким предложением.')
    await ctx.call('getContextUsage')
  })

// ── 2. Разрешения: Edit, Bash, Write; «всегда» в localSettings; отказ ──
const s2 = () =>
  scenario('02-permissions-edit', {}, async (ctx) => {
    ctx.decide = (toolName, input, opts, nth) => {
      if (toolName === 'Bash' && String(input.command).includes('.deny-probe')) {
        return { behavior: 'deny', message: 'Пользователь отклонил команду: не трогай этот файл.' }
      }
      // Подсказка для Edit — смена режима на сессию; «всегда для Edit» в файл — своим правилом.
      if (toolName === 'Edit' && nth === 0) {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' }],
        }
      }
      // Для Bash — подсказки как пришли: правило в localSettings плюс каталог на сессию.
      if (toolName === 'Bash') return { behavior: 'allow', updatedInput: input, updatedPermissions: opts.suggestions ?? [] }
      return undefined
    }

    await ctx.turn(
      'Сделай по порядку, без лишних слов: 1) прочитай README.md; 2) инструментом Edit добавь в самый конец README.md строку `<!-- sdk-probe 1 -->`; 3) выполни в Bash ровно такую команду: `echo probe > spikes/sdk-probe/.bash-probe.tmp`.',
    )
    ctx.log.probe('local_settings', { after: 'turn 1', content: existsSync(LOCAL_SETTINGS) ? readFileSync(LOCAL_SETTINGS, 'utf8') : null })

    await ctx.turn(
      'Ещё раз: 1) инструментом Edit добавь в конец README.md строку `<!-- sdk-probe 2 -->`; 2) выполни в Bash ровно: `echo probe > spikes/sdk-probe/.bash-probe-2.tmp`; 3) инструментом Write создай файл spikes/sdk-probe/.write-probe.tmp с содержимым `probe`.',
    )
    ctx.log.probe('permission_calls', { after: 'turn 2', calls: ctx.permissionCalls.map((c) => c.toolName) })

    // «Всегда» для команды без записи в файл: второй такой же вызов не должен дойти до canUseTool.
    await ctx.turn('Выполни в Bash ровно такую команду: `node -e "console.log(1)"`. Ответь одним словом.')
    await ctx.turn('Ещё раз выполни в Bash ровно ту же команду: `node -e "console.log(1)"`. Ответь одним словом.')
    ctx.log.probe('permission_calls', { after: 'turn 4', calls: ctx.permissionCalls.map((c) => `${c.toolName}${c.input.command ? `: ${c.input.command}` : ''}`) })

    await ctx.turn('Выполни в Bash ровно такую команду: `touch spikes/sdk-probe/.deny-probe.tmp`. Если откажут — не повторяй, просто скажи об этом.')
    ctx.log.probe('permission_calls', { after: 'turn 5', calls: ctx.permissionCalls.map((c) => c.toolName) })
  })

// ── 3. AskUserQuestion ──
const s3 = () =>
  scenario('03-ask-user-question', {}, async (ctx) => {
    ctx.decide = (toolName, input) => {
      if (toolName !== 'AskUserQuestion') return undefined
      const answers = {}
      for (const question of input.questions ?? []) answers[question.question] = question.options?.[1]?.label ?? 'Синий'
      return { behavior: 'allow', updatedInput: { ...input, answers } }
    }
    await ctx.turn(
      'Вызови инструмент AskUserQuestion: один вопрос «Какой цвет выбрать для шкалы?», заголовок «Цвет», варианты «Красный», «Синий», «Зелёный» с короткими описаниями. После ответа напиши одним предложением, что я выбрал.',
    )
  })

// ── 4. Plan mode: ExitPlanMode → «доработать» (deny) → одобрить с переходом в acceptEdits ──
const s4 = () =>
  scenario('04-plan-mode', { permissionMode: 'plan' }, async (ctx) => {
    ctx.decide = (toolName, input, opts, nth) => {
      if (toolName !== 'ExitPlanMode') return undefined
      if (nth === 0) return { behavior: 'deny', message: 'Доработай план: добавь последним пунктом проверку через git diff.' }
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      }
    }
    await ctx.turn(
      'Нужно добавить в конец README.md строку `<!-- sdk-probe plan -->`. Составь короткий план из 2–3 пунктов и представь его через ExitPlanMode. Долго не исследуй — достаточно заглянуть в README.md.',
    )
    await ctx.call('getContextUsage')
  })

// ── 5. Субагенты: Explore, фоновая задача и stopTask, явный передний план ──
const s5 = () =>
  scenario('05-subagents', { forwardSubagentText: true, agentProgressSummaries: true }, async (ctx) => {
    const isAgentStart = (m) => m.type === 'system' && m.subtype === 'task_started' && m.task_type === 'local_agent'
    const noteOf = (id) => (m) => m.type === 'system' && m.subtype === 'task_notification' && m.task_id === id
    // Уведомление о фоновой задаче будит главного агента отдельным ходом — дождаться его итога.
    const wakeResult = (label) =>
      ctx.waitFor(label, (m) => m.type === 'result', 90_000).then(
        () => ctx.log.probe('wake_turn', { label, arrived: true }),
        () => ctx.log.probe('wake_turn', { label, arrived: false }),
      )

    ctx.send(
      'Запусти Explore-агента (инструмент Agent, subagent_type: "Explore") с задачей: найти в каталоге docs/ файлы, где упоминается getContextUsage, и вернуть список путей. Потом перечисли мне эти файлы одной строкой.',
    )
    const explore = await ctx.waitFor('task_started Explore', isAgentStart)
    await ctx.result('result хода с Explore')
    if (explore.is_backgrounded) {
      await ctx.seenWithin(noteOf(explore.task_id), 120_000)
      await wakeResult('после Explore')
    }

    ctx.send(
      'Запусти в фоне (run_in_background: true) агента general-purpose с задачей: выполнить в Bash команду `node -e "setTimeout(()=>{}, 90000)"` и после неё ответить «готово». Не жди его — сразу ответь мне «запущено».',
    )
    const background = await ctx.waitFor('task_started фоновой задачи', isAgentStart)
    await ctx.result('result хода с фоновым запуском')
    await sleep(5000)
    await ctx.call('stopTask', background.task_id)
    const note = await ctx.seenWithin(noteOf(background.task_id), 30_000)
    ctx.log.probe('task_notification_after_stop', { task_id: background.task_id, arrived: Boolean(note), status: note?.status ?? null })
    await wakeResult('после stopTask')

    ctx.send(
      'Запусти Explore-агента с параметром run_in_background: false и задачей: посчитать файлы .md в каталоге docs/roadmap. Дождись его ответа и назови мне число.',
    )
    const foreground = await ctx.waitFor('task_started с run_in_background: false', isAgentStart)
    ctx.log.probe('foreground_attempt', { task_id: foreground.task_id, is_backgrounded: foreground.is_backgrounded })
    await ctx.result('result хода с run_in_background: false')
    if (foreground.is_backgrounded) {
      await ctx.seenWithin(noteOf(foreground.task_id), 120_000)
      await wakeResult('после третьего агента')
    }
  })

// ── 6. Компакция: /compact промптом ──
const s6 = () =>
  scenario('06-compact', {}, async (ctx) => {
    await ctx.turn('Прочитай prototype/README.md и одной строкой скажи, сколько в нём заголовков второго уровня.')
    await ctx.call('getContextUsage')
    await ctx.turn('/compact')
    await ctx.call('getContextUsage')
    await ctx.turn('О каком файле мы говорили? Одно предложение.')
    await ctx.call('getContextUsage')
  })

// ── 7. Thinking: display summarized, какие stream_event приходят (Sonnet, затем Opus) ──
const s7 = () =>
  scenario('07-thinking', { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' }, async (ctx) => {
    await ctx.turn(
      'Подумай как следует: сколькими способами можно расставить 5 не бьющих друг друга ладей на доске 5×5 так, чтобы ни одна не стояла на главной диагонали? Дай число и одно предложение обоснования.',
    )
    await ctx.call('setModel', OPUS)
    await ctx.turn(
      'Подумай как следует: в ряд стоят 6 ламп, соседние не могут гореть одновременно. Сколько есть допустимых состояний? Дай число и одно предложение обоснования.',
    )
  })

// ── 8. Сессии: listSessions, getSessionMessages, resume — копится ли стоимость ──
async function s8(firstSessionId) {
  const log = openLog('08-sessions-list')
  const probeLogs = readdirSync(LOGS).filter((f) => /^\d\d-.*\.jsonl$/.test(f))
  const ours = new Set()
  for (const file of probeLogs) {
    const head = readFileSync(join(LOGS, file), 'utf8').split('\n').slice(0, 40)
    for (const line of head) {
      const id = /"subtype":"init".*?"session_id":"([0-9a-f-]+)"/.exec(line)?.[1] ?? /"session_id":"([0-9a-f-]+)".*"subtype":"init"/.exec(line)?.[1]
      if (id) ours.add(id)
    }
  }
  const sessionId = firstSessionId ?? firstInitSession('01-basic-control')
  const all = await listSessions({ dir: REPO })
  // В лог — только сессии самой пробы: у владельца в этом каталоге свои разговоры.
  log.probe('listSessions', { total: all.length, keys: [...new Set(all.flatMap((s) => Object.keys(s)))], ours: all.filter((s) => ours.has(s.sessionId)) })
  if (!sessionId) {
    log.probe('skipped', { reason: 'нет сессии сценария 1' })
    return
  }
  log.probe('getSessionInfo', { sessionId, result: (await getSessionInfo(sessionId, { dir: REPO })) ?? null })
  const messages = await getSessionMessages(sessionId, { dir: REPO })
  log.probe('getSessionMessages', {
    sessionId,
    count: messages.length,
    types: messages.map((m) => m.type),
    assistantWithUsage: messages.filter((m) => m.type === 'assistant' && m.message?.usage).length,
  })
  for (const message of messages) log.probe('session_message', { message })
  const withSystem = await getSessionMessages(sessionId, { dir: REPO, includeSystemMessages: true })
  log.probe('getSessionMessages_includeSystem', { count: withSystem.length, types: withSystem.map((m) => `${m.type}${m.subtype ? `/${m.subtype}` : ''}`) })

  const before = lastResult('01-basic-control')
  log.probe('before_resume', { total_cost_usd: before?.total_cost_usd ?? null, num_turns: before?.num_turns ?? null, modelUsage: before?.modelUsage ?? null })
  await scenario(
    '08-sessions-resume',
    { resume: sessionId, title: undefined },
    async (ctx) => {
      await ctx.call('getContextUsage')
      await ctx.turn('Сколько будет 2+2? Только число.')
    },
    { baselineUsd: before?.total_cost_usd ?? 0 },
  )
}

function firstInitSession(name) {
  try {
    for (const line of readFileSync(join(LOGS, `${name}.jsonl`), 'utf8').split('\n')) {
      if (!line) continue
      const message = JSON.parse(line)
      if (message.type === 'system' && message.subtype === 'init') return message.session_id
    }
  } catch {}
  return undefined
}

function lastResult(name) {
  try {
    const lines = readFileSync(join(LOGS, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    return lines.findLast((m) => m.type === 'result')
  } catch {
    return undefined
  }
}

// ── 9. Контекст до и после хода на обеих моделях, rate_limit_event, accountInfo ──
const s9 = async () => {
  for (const [name, model] of [
    ['09-context-sonnet', SONNET],
    ['09-context-opus', OPUS],
  ]) {
    await scenario(name, { model }, async (ctx) => {
      await ctx.call('accountInfo')
      await ctx.call('getContextUsage')
      await ctx.turn('Ответь одним словом: ок.')
      await ctx.call('getContextUsage')
      await ctx.call('getContextUsage', { detail: 'full' })
      await ctx.turn('Назови три цвета радуги через запятую.')
      await ctx.call('getContextUsage')
    })
  }
}

// ── 10. GET /api/oauth/usage токеном Claude Code ──
function readToken() {
  const parse = (raw) => {
    try {
      const token = JSON.parse(raw)?.claudeAiOauth?.accessToken
      return typeof token === 'string' && token !== '' ? token : undefined
    } catch {
      return undefined
    }
  }
  try {
    const token = parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'))
    if (token) return { token, from: 'file' }
  } catch {}
  if (process.platform !== 'darwin') return { from: 'missing' }
  try {
    const raw = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const token = parse(raw)
    return token ? { token, from: 'keychain' } : { from: 'missing' }
  } catch {
    return { from: 'missing' }
  }
}

async function s10() {
  const log = openLog('10-oauth-usage')
  const url = 'https://api.anthropic.com/api/oauth/usage'
  const { token, from } = readToken()
  log.probe('credentials', { from, found: Boolean(token) })
  if (!token) {
    console.log('✗ 10-oauth-usage: токен не найден')
    return
  }
  REDACT.add(token)
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'agentura-sdk-probe' }

  // fetch из Node: Agentmeter в августе получал 403 от Cloudflare по отпечатку TLS — перепроверяем.
  try {
    const response = await fetch(url, { headers })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text.slice(0, 300)
    }
    log.probe('node_fetch', { node: process.version, status: response.status, retryAfter: response.headers.get('retry-after'), contentType: response.headers.get('content-type'), body })
  } catch (error) {
    log.probe('node_fetch', { node: process.version, error: String(error?.message ?? error) })
  }

  // curl: заголовок с токеном — через stdin, чтобы не светить его в списке процессов.
  try {
    const out = execFileSync(
      '/usr/bin/curl',
      ['-sS', '--max-time', '20', '-H', '@-', '-H', 'accept: application/json', '-H', 'anthropic-beta: oauth-2025-04-20', '-H', 'user-agent: agentura-sdk-probe', '-w', '\n__STATUS__%{http_code}', url],
      { input: `authorization: Bearer ${token}\n`, encoding: 'utf8' },
    )
    const [text, status] = out.split('\n__STATUS__')
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text.slice(0, 300)
    }
    log.probe('curl', { status: Number(status), body })
    console.log(`✓ 10-oauth-usage: curl ${status}`)
  } catch (error) {
    log.probe('curl', { error: String(error?.message ?? error) })
    console.log(`✗ 10-oauth-usage: ${error?.message ?? error}`)
  }
}

// ── Запуск ──
mkdirSync(LOGS, { recursive: true })
const picked = process.argv.slice(2).map(Number).filter(Boolean)
const want = (n) => picked.length === 0 || picked.includes(n)
if (picked.length === 0) writeFileSync(LEDGER, JSON.stringify({ budgetUsd: BUDGET_USD, spentUsd: 0, scenarios: [] }, null, 2) + '\n')

let first
if (want(1)) first = await s1()
if (want(2)) await s2()
if (want(3)) await s3()
if (want(4)) await s4()
if (want(5)) await s5()
if (want(6)) await s6()
if (want(7)) await s7()
if (want(8)) await s8(first?.sessionId)
if (want(9)) await s9()
if (want(10)) await s10()

const ledger = readLedger()
console.log(`Итого по оценке SDK: $${ledger.spentUsd.toFixed(4)} из $${ledger.budgetUsd}`)
