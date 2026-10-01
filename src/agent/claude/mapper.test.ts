import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import { ClaudeEventMapper, windowsFromRateLimit } from './mapper';
import { PermissionBroker } from './permissions';
import { PROBE_BASELINES, projectEvents, replayProbeLog } from './replay';

const logsDir = join(__dirname, '..', '..', '..', 'spikes', 'sdk-probe', 'logs');
const fixturesDir = join(__dirname, '__fixtures__');

function readLog(name: string): Record<string, unknown>[] {
  return readFileSync(join(logsDir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function ofType<T extends AgentEvent['type']>(events: AgentEvent[], type: T): AgentEventOf<T>[] {
  return events.filter((e): e is AgentEventOf<T> => e.type === type);
}

const expectedFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.expected.json'));

describe('маппинг логов пробы → события (ожидания в __fixtures__)', () => {
  it('ожидания есть', () => expect(expectedFiles.length).toBeGreaterThanOrEqual(10));

  for (const file of expectedFiles) {
    const name = file.replace(/\.expected\.json$/, '');
    it(name, async () => {
      const expected = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as {
        counts: Record<string, number>;
        events: unknown[];
        permissionResults: unknown[];
      };
      const { events, permissionResults } = await replayProbeLog(
        readLog(name),
        PROBE_BASELINES[name] ?? 0,
      );
      const counts: Record<string, number> = {};
      for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
      expect(counts).toEqual(expected.counts);
      expect(projectEvents(events)).toEqual(expected.events);
      expect(permissionResults).toEqual(expected.permissionResults);
    });
  }
});

describe('инварианты маппинга по сырым логам', () => {
  const logs = ['01-basic-control', '02-permissions-edit', '05-subagents', '07-thinking'];

  it.each(logs)('%s: usage один раз на message.id', async (name) => {
    const lines = readLog(name);
    const ids = new Set(
      lines
        .filter((l) => l['type'] === 'assistant')
        .map((l) => (l['message'] as { id: string }).id),
    );
    const { events } = await replayProbeLog(lines);
    const usage = ofType(events, 'usage.message');
    expect(usage.map((u) => u.messageId).sort()).toEqual([...ids].sort());
  });

  it.each(logs)('%s: ход на каждый result', async (name) => {
    const lines = readLog(name);
    const results = lines.filter((l) => l['type'] === 'result');
    const { events } = await replayProbeLog(lines);
    expect(ofType(events, 'turn.result')).toHaveLength(results.length);
    expect(ofType(events, 'turn.start')).toHaveLength(results.length);
  });

  // Стоимость хода — разность total_cost_usd соседних result (значения выписаны из логов руками).
  it.each([
    // 3-й ход — Opus после setModel: его цена = modelUsage["claude-opus-5-5"].costUSD (01:66).
    ['01-basic-control', [0.004333, 0, 0.068158]],
    ['02-permissions-edit', [0.049491, 0.016518, 0.011013, 0.010802, 0.011617]],
    ['05-subagents', [0.041639, 0.030339, 0.01501, 0.039381, 0.040057]],
    ['07-thinking', [0.006057, 0.071854]],
  ] as const)('%s: стоимость каждого хода', async (name, costs) => {
    const { events } = await replayProbeLog(readLog(name));
    expect(ofType(events, 'turn.result').map((t) => t.costUsd)).toEqual(costs);
  });

  it('resume: стоимость первого хода — от базы, без базы — неизвестна', async () => {
    const lines = readLog('08-sessions-resume');
    const withBase = await replayProbeLog(lines, 0.07249180000000001);
    expect(ofType(withBase.events, 'turn.result')[0]?.costUsd).toBe(0.036072);
    const m = new ClaudeEventMapper();
    const noBase = lines.flatMap((l) => (l['type'] === 'probe' ? [] : m.map(l)));
    expect(ofType(noBase, 'turn.result')[0]?.costUsd).toBeUndefined();
  });

  it('вывод в usage — из message_delta, а не плейсхолдер assistant', async () => {
    const { events } = await replayProbeLog(readLog('02-permissions-edit'));
    const u = ofType(events, 'usage.message').find((e) => e.messageId.endsWith('mH8v9'));
    expect(u?.usage.output).toBe(214); // в assistant было 16 (02-permissions-edit:44 → :60)
    expect(u?.final).toBe(true);
  });

  it('прерванный ход: без стоимости, с токенами оборванного ответа', async () => {
    const { events } = await replayProbeLog(readLog('01-basic-control'));
    const aborted = ofType(events, 'turn.result').find((t) => t.interrupted);
    expect(aborted).toMatchObject({ ok: false, costUsd: 0, terminalReason: 'aborted_streaming' });
    expect(aborted?.usage).toMatchObject({ input: 2, cacheRead: 20797, cacheWrite: 96 });
  });

  it('Bash: canUseTool → permission.request → ответ «всегда» возвращает подсказки движка', async () => {
    const lines = readLog('02-permissions-edit');
    const { events, permissionResults } = await replayProbeLog(lines);
    const bash = ofType(events, 'permission.request').find((p) => p.toolUseId.endsWith('692XPk'));
    expect(bash).toMatchObject({
      toolName: 'Bash',
      canAlwaysAllow: true,
      reason: 'This command requires approval',
    });
    expect(
      ofType(events, 'permission.resolved').find((r) => r.toolUseId === bash?.toolUseId),
    ).toMatchObject({
      decision: 'allow',
      by: 'user',
    });

    // Что брокер вернул движку — то же, что вернула проба (кроме Edit «всегда»: проба писала своё
    // правило `Edit`, брокер отдаёт подсказку движка `setMode acceptEdits`).
    const probe = lines.filter((l) => l['kind'] === 'canUseTool_result');
    for (const { toolUseId, result } of permissionResults) {
      const original = probe.find((l) => l['toolUseID'] === toolUseId)?.['result'] as Record<
        string,
        unknown
      >;
      if (toolUseId === 'toolu_0138YwF1CMiMWe1aAUSFa7ch') {
        expect(result).toMatchObject({
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        });
      } else {
        expect(result).toEqual(original);
      }
    }
  });

  it('вопрос и план: ответы в той же форме, что проверила проба', async () => {
    for (const name of ['03-ask-user-question', '04-plan-mode']) {
      const lines = readLog(name);
      const { permissionResults } = await replayProbeLog(lines);
      const probe = lines.filter((l) => l['kind'] === 'canUseTool_result');
      expect(permissionResults.map((r) => r.result)).toEqual(probe.map((l) => l['result']));
    }
  });

  it('субагент: parent_tool_use_id → agentId, agentID из canUseTool → тот же agentId', async () => {
    const { events } = await replayProbeLog(readLog('05-subagents'));
    const start = ofType(events, 'agent.start').find((a) => a.taskId === 'a35ed511b55803b6d');
    expect(start?.agentId).toBe('toolu_01FV2hGPXqVRj5W6VcdopsEM');
    const request = ofType(events, 'permission.request')[0];
    expect(request?.agentId).toBe(start?.agentId);
    const nested = ofType(events, 'agent.start').find((a) => a.taskType === 'local_bash');
    expect(nested?.parentAgentId).toBe(start?.agentId);
    expect(ofType(events, 'agent.end').map((a) => a.status)).toEqual([
      'completed',
      'stopped',
      'stopped',
      'completed',
    ]);
    // Ход-пробуждение после фоновой задачи начат движком: без prompt, origin в итоге.
    const wake = ofType(events, 'turn.result').filter((t) => t.origin === 'task-notification');
    expect(wake.length).toBeGreaterThan(0);
  });

  it('компакция: start → end с было/стало', async () => {
    const { events } = await replayProbeLog(readLog('06-compact'));
    expect(ofType(events, 'compaction.end')[0]).toMatchObject({
      ok: true,
      trigger: 'manual',
      preTokens: 21122,
      postTokens: 1393,
    });
    const i = events.findIndex((e) => e.type === 'compaction.start');
    expect(events[i - 1]).toMatchObject({ type: 'turn.start', prompt: '/compact' });
  });
});

describe('rate_limit_event', () => {
  it('оба окна из unifiedWindows', () => {
    expect(
      windowsFromRateLimit({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: 1790787000,
        unifiedWindows: {
          five_hour: { utilization: 0.79, resetsAt: 1790787000 },
          seven_day: { utilization: 0.36, resetsAt: 1790856000 },
        },
      }),
    ).toEqual([
      { kind: 'five-hour', percent: 79, resetsAt: 1790787000000 },
      { kind: 'weekly', percent: 36, resetsAt: 1790856000000 },
    ]);
  });

  it('без unifiedWindows — одно окно из rateLimitType + utilization, без них — пусто', () => {
    expect(
      windowsFromRateLimit({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 100 }),
    ).toEqual([{ kind: 'weekly', percent: 50, resetsAt: 100000 }]);
    expect(
      windowsFromRateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 100 }),
    ).toEqual([]);
    const m = new ClaudeEventMapper();
    expect(
      m.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 100 } }),
    ).toEqual([
      { type: 'limit.update', source: 'engine', windows: [], status: 'rejected', resetsAt: 100000 },
    ]);
  });
});

describe('PermissionBroker', () => {
  it('отмена движком (abort) — deny и permission.resolved by abort', async () => {
    const events: AgentEvent[] = [];
    const broker = new PermissionBroker((e) => events.push(e));
    const ctrl = new AbortController();
    const pending = broker.canUseTool(
      'Bash',
      { command: 'ls' },
      { signal: ctrl.signal, toolUseID: 't1' },
    );
    expect(broker.waiting).toEqual(['t1']);
    ctrl.abort();
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(events.at(-1)).toEqual({
      type: 'permission.resolved',
      toolUseId: 't1',
      decision: 'deny',
      by: 'abort',
    });
    expect(broker.respondPermission('t1', 'allow')).toBe(false);
  });

  it('Edit — превью диффа; allow без «всегда» — без updatedPermissions; вопрос нельзя «разрешить»', async () => {
    const events: AgentEvent[] = [];
    const broker = new PermissionBroker((e) => events.push(e));
    const input = { file_path: '/a.ts', old_string: 'a', new_string: 'b', replace_all: false };
    const p = broker.canUseTool('Edit', input, {
      toolUseID: 'e1',
      suggestions: [{ type: 'setMode' }],
    });
    expect(events[0]).toMatchObject({
      type: 'permission.request',
      diff: { kind: 'edit', filePath: '/a.ts', oldText: 'a', newText: 'b', replaceAll: false },
      canAlwaysAllow: true,
    });
    broker.respondPermission('e1', 'allow');
    await expect(p).resolves.toEqual({ behavior: 'allow', updatedInput: input });

    const q = broker.canUseTool('AskUserQuestion', { questions: [] }, { toolUseID: 'q1' });
    expect(broker.respondPermission('q1', 'allow')).toBe(false);
    expect(broker.respondPermission('q1', 'deny', 'не сейчас')).toBe(true);
    await expect(q).resolves.toEqual({ behavior: 'deny', message: 'не сейчас' });
  });

  it('«всегда» — ровно подсказки движка без перехода в bypass; allow-edits — только acceptEdits', async () => {
    const broker = new PermissionBroker(() => undefined);
    const rule = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    const bypass = { type: 'setMode', mode: 'bypassPermissions', destination: 'session' };
    const input = { command: 'npm test' };
    const a = broker.canUseTool('Bash', input, { toolUseID: 'b1', suggestions: [rule, bypass] });
    expect(broker.respondPermission('b1', 'allow-always')).toBe(true);
    await expect(a).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [rule],
    });
    // одна кнопка — один ответ: повтор по тому же id отброшен
    expect(broker.respondPermission('b1', 'deny')).toBe(false);

    const only = broker.canUseTool('Bash', input, { toolUseID: 'b2', suggestions: [bypass] });
    broker.respondPermission('b2', 'allow-always');
    await expect(only).resolves.toEqual({ behavior: 'allow', updatedInput: input });

    const e = broker.canUseTool('Edit', {}, { toolUseID: 'e2', suggestions: [rule] });
    broker.respondPermission('e2', 'allow-edits');
    await expect(e).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('allow-edits на файле вне рабочих папок добавляет addDirectories из подсказок движка', async () => {
    const broker = new PermissionBroker(() => undefined);
    // подсказка движка может звать в `localSettings` — «до конца сессии» в настройки не пишет
    const dirs = {
      type: 'addDirectories',
      directories: ['/other/place'],
      destination: 'localSettings',
    };
    const e = broker.canUseTool('Edit', {}, { toolUseID: 'e3', suggestions: [dirs] });
    broker.respondPermission('e3', 'allow-edits');
    await expect(e).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { ...dirs, destination: 'session' },
      ],
    });
  });
});
