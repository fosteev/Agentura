#!/usr/bin/env node
// ✦ во вкладке «git» на живом движке: временный репозиторий с индексом → одноразовый запрос → сообщение;
// проверка, что запрос не оставил сессии в списке проекта (транскриптов в ~/.claude/projects/<cwd> нет).
//   node scripts/commit-message-smoke.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { MESSAGE_MODEL, MESSAGE_SYSTEM, messagePrompt } = await loadTs(
  'src/extension/git/commitMessage.ts',
);
const { projectDir } = await loadTs('src/data/sessions.ts');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentura-msg-')));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
let code = 1;
try {
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'smoke');
  writeFileSync(join(dir, 'retry.js'), 'export function retry(fn) {\n  return fn();\n}\n');
  git('add', '.');
  git('commit', '-qm', 'Add retry helper');
  writeFileSync(
    join(dir, 'retry.js'),
    'export async function retry(fn, times = 3) {\n  for (let i = 0; ; i++) {\n    try {\n      return await fn();\n    } catch (e) {\n      if (i + 1 >= times) throw e;\n    }\n  }\n}\n',
  );
  git('add', '.');
  const prompt = messagePrompt([
    {
      name: 'smoke',
      stat: git('diff', '--cached', '--stat', '--no-color'),
      diff: git('diff', '--cached', '--no-color', '--no-ext-diff'),
      subjects: git('log', '-n5', '--format=%s').split('\n').filter(Boolean),
    },
  ]);
  const adapter = new ClaudeAdapter({ clientApp: 'agentura-smoke/0' });
  const started = Date.now();
  const text = await adapter.complete(dir, {
    system: MESSAGE_SYSTEM,
    prompt,
    model: MESSAGE_MODEL,
  });
  console.log(`ответ за ${Date.now() - started} мс:\n---\n${text}\n---`);
  const pdir = projectDir(dir);
  const files = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith('.jsonl')) : [];
  const listed = await adapter.listSessions(dir);
  console.log(`транскриптов в ${pdir}: ${files.length}; listSessions: ${listed.length}`);
  code = files.length === 0 && listed.length === 0 && text.trim() ? 0 : 1;
} catch (e) {
  console.error(String(e));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
