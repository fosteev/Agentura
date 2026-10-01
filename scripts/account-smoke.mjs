#!/usr/bin/env node
// Секция «Аккаунт» боковой панели на живом движке и учётных данных (токен не печатается):
//   node scripts/account-smoke.mjs
import { loadTs } from './lib/load-ts.mjs';

const { ClaudeAdapter } = await loadTs('src/agent/claude/adapter.ts');
const { LimitsSource } = await loadTs('src/data/limits.ts');
const { AccountService } = await loadTs('src/extension/account.ts');

const adapter = new ClaudeAdapter({ clientApp: 'agentura-smoke/0' });
const limits = new LimitsSource({});
const svc = new AccountService({
  accountInfo: () => adapter.accountInfo(process.cwd()),
  readPlan: () => limits.readPlan(),
});
const started = Date.now();
const a = await svc.get();
console.log(
  `аккаунт за ${Date.now() - started} мс:`,
  JSON.stringify({ ...a, email: a.email ? a.email.replace(/^(.).*(@.*)$/, '$1***$2') : undefined }),
);
process.exit(a.error ? 1 : 0);
