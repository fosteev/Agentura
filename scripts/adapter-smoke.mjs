#!/usr/bin/env node
// Дымовой прогон адаптера на живом движке (тратит лимит подписки — прогоны короткие).
//   node scripts/adapter-smoke.mjs "скажи привет"
//   node scripts/adapter-smoke.mjs "скажи привет" --bash            — второй ход: команда Bash через permission.request
//   node scripts/adapter-smoke.mjs "…" --bash --deny                — то же, но ответ «отклонить»
//   --model <id> (по умолчанию claude-sonnet-5-5), --cwd <папка> (по умолчанию корень репозитория), --account
// С --bash настройки пользователя (~/.claude/settings.json) не грузятся: там могут быть правила вроде
// `permissions.allow: ["Bash"]`, и запрос разрешения не придёт вовсе. --user-settings — грузить всё равно.
import { loadTs, repoRoot } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const prompt =
  args.find((a, i) => !a.startsWith('--') && !['--model', '--cwd'].includes(args[i - 1])) ??
  'скажи привет';
const model = value('--model', 'claude-sonnet-5-5');
const cwd = value('--cwd', repoRoot);
const bashCommand = `node -e "console.log('agentura-smoke-' + (6 * 7))"`;

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const withoutUser = flag('--bash') && !flag('--user-settings');
if (withoutUser)
  console.log('  (настройки пользователя не грузим: правила allow закрыли бы запрос разрешения)');
const adapter = new ClaudeAdapter({
  clientApp: 'agentura-smoke/0',
  ...(withoutUser ? { settingSources: ['project', 'local'] } : {}),
  log: (level, message) => level !== 'debug' && console.error(`  [${level}] ${message}`),
  // Эхо наших uuid на сообщениях хода — по нему маппер привязывает промпт к ходу.
  trace: (m) => {
    const echo =
      m?.user_message_uuids ?? (m?.user_message_uuid ? [m.user_message_uuid] : undefined);
    if (echo)
      console.log(
        `  (эхо user_message_uuid на ${m.type}${m.event ? '/' + m.event.type : ''}: ${echo.length} шт.)`,
      );
  },
});

if (flag('--account')) console.log('account', await adapter.accountInfo(cwd));

const session = await adapter.createSession({
  cwd,
  model,
  title: `agentura smoke: ${prompt.slice(0, 40)}`,
});
const started = Date.now();
const t = () => `${String(((Date.now() - started) / 1000).toFixed(1)).padStart(5)}s`;
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, '⏎');

let textRun = '';
const flushText = () => {
  if (textRun) console.log(`${t()} text.delta ×… «${short(textRun, 120)}»`);
  textRun = '';
};

const waiters = [];
const waitFor = (pred, ms = 180_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('таймаут ожидания события')), ms);
    waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });

session.events.on((e) => {
  if (e.type === 'text.delta') {
    textRun += e.text;
  } else {
    flushText();
    const a = e.agentId ? `[${e.agentId.slice(-5)}] ` : '';
    switch (e.type) {
      case 'session.init':
        console.log(
          `${t()} ${a}session.init ${e.sessionId} model=${e.model} mode=${e.permissionMode} apiKeySource=${e.apiKeySource} engine=${e.engineVersion} tools=${e.tools.length}`,
        );
        break;
      case 'thinking.delta':
        break;
      case 'tool.start':
        console.log(`${t()} ${a}tool.start ${e.name} ${short(JSON.stringify(e.input))}`);
        break;
      case 'tool.result':
        console.log(
          `${t()} ${a}tool.result err=${e.isError} ${e.durationMs ?? '?'}ms «${short(e.content)}»`,
        );
        break;
      case 'permission.request':
        console.log(
          `${t()} ${a}permission.request ${e.toolName} «${short(e.description ?? '')}» reason=${e.reason ?? '-'} always=${e.canAlwaysAllow}`,
        );
        break;
      case 'usage.message':
        console.log(
          `${t()} ${a}usage.message ${e.model} in=${e.usage.input} out=${e.usage.output} cr=${e.usage.cacheRead} cw=${e.usage.cacheWrite} final=${e.final}`,
        );
        break;
      case 'context.usage':
        console.log(
          `${t()} ${a}context.usage ${e.source} ${e.usedTokens}/${e.maxTokens ?? '?'}${e.percentage !== undefined ? ` (${e.percentage}%)` : ''}`,
        );
        break;
      case 'turn.result':
        console.log(
          `${t()} turn.result ok=${e.ok} ${e.subtype} cost=$${e.costUsd?.toFixed(4) ?? '?'} total=$${e.totalCostUsd.toFixed(4)} ` +
            `tokens in=${e.usage.input} out=${e.usage.output} cr=${e.usage.cacheRead} cw=${e.usage.cacheWrite} ` +
            `window=${e.contextWindow ?? '?'} model=${e.model} ${e.durationMs}ms turns=${e.numTurns}`,
        );
        break;
      default:
        console.log(
          `${t()} ${a}${e.type} ${short(JSON.stringify({ ...e, type: undefined, agentId: undefined }), 140)}`,
        );
    }
  }
  for (const w of [...waiters]) {
    if (w.pred(e)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(e);
    }
  }
});

let exitCode = 0;
try {
  console.log(`${t()} → send «${prompt}» (model ${model}, cwd ${cwd})`);
  session.send(prompt);
  await waitFor((e) => e.type === 'turn.result');

  if (flag('--bash')) {
    const deny = flag('--deny');
    const text = `Выполни в Bash ровно такую команду: \`${bashCommand}\`. Ответь одним словом — что она вывела.`;
    console.log(`${t()} → send «${short(text)}»`);
    const request = waitFor((e) => e.type === 'permission.request' && e.toolName === 'Bash');
    const result = waitFor((e) => e.type === 'turn.result');
    session.send(text);
    const req = await Promise.race([request, result]);
    if (req.type !== 'permission.request') {
      console.log(
        `${t()} !! ход закончился без permission.request — команду разрешило правило настроек?`,
      );
      exitCode = 2;
    } else {
      const ok = session.respondPermission(
        req.toolUseId,
        deny ? 'deny' : 'allow',
        deny ? 'Smoke: отклонено.' : undefined,
      );
      console.log(
        `${t()} ← respondPermission(${req.toolUseId}, ${deny ? 'deny' : 'allow'}) → ${ok}`,
      );
      await result;
    }
  }
} catch (error) {
  console.error(`ошибка: ${error.message}`);
  exitCode = 1;
} finally {
  flushText();
  session.dispose();
}
process.exit(exitCode);
