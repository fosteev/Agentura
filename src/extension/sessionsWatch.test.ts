import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, SessionInfo } from '../agent/types';
import { parsePlan } from '../data/limits';
import { LiveSessions, TranscriptCache } from '../data/sessions';
import { SessionsService } from './sessionsService';

/** Настоящий `fs.watch`: запись транскрипта в каталог проекта приводит к пересчёту списка. */
describe('SessionsService на настоящем fs.watch', () => {
  it('новый файл транскрипта → список пересобран с дебаунсом', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentura-watch-'));
    let list: SessionInfo[] = [];
    const listSessions = vi.fn(async () => list);
    const svc = new SessionsService({
      adapter: { listSessions } as unknown as AgentAdapter,
      cwd: dir,
      live: new LiveSessions(),
      cache: new TranscriptCache(),
      log: { debug: vi.fn(), warn: vi.fn() },
      dir,
      debounceMs: 60,
      maxWaitMs: 500,
    });
    const updates: number[] = [];
    svc.onChange((r) => updates.push(r.length));
    svc.start();
    await svc.refresh();
    const before = listSessions.mock.calls.length;
    list = [{ id: 'new', title: 'новая', updatedAt: Date.now() }];
    // FSEvents на macOS заводится не мгновенно: пишем, пока слежение не отзовётся
    let n = 0;
    await vi.waitFor(
      () => {
        writeFileSync(join(dir, 'new.jsonl'), `${'{}\n'.repeat(++n)}`);
        expect(updates.at(-1)).toBe(1);
      },
      { timeout: 5000, interval: 150 },
    );
    // серия записей не дала шквала пересчётов: не больше одного на ~дебаунс
    expect(listSessions.mock.calls.length - before).toBeLessThanOrEqual(n + 1);
    svc.dispose();
  });
});

describe('parsePlan', () => {
  it('берёт только план, токен не читает', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'secret',
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
    });
    const plan = parsePlan(raw);
    expect(plan).toEqual({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' });
    expect(JSON.stringify(plan)).not.toContain('secret');
    expect(parsePlan('не json')).toEqual({});
    expect(parsePlan('{}')).toEqual({});
  });
});
