import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentEventOf, AgentSession, SessionOptions } from '../types';
import { AntigravityAdapter, modeArgs, type AntigravityAdapterConfig } from './adapter';
import { FAKE_CONVERSATION, fakeSpawn, type FakeAgy } from './fakeAgy';

const OPTIONS: SessionOptions = { cwd: '/tmp/agentura-agy' };

function setup(config: Partial<AntigravityAdapterConfig> = {}, script?: Parameters<typeof fakeSpawn>[0]) {
  const { spawn, spawns } = fakeSpawn(script);
  const logs: string[] = [];
  const adapter = new AntigravityAdapter({
    executablePath: '/bin/agy',
    spawn,
    graceMs: 30,
    log: (level, message) => logs.push(`${level}: ${message}`),
    listProcesses: async () => [],
    killPid: () => undefined,
    ...config,
  });
  return { adapter, spawns, logs };
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.events.on((e) => events.push(e));
  return events;
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);
const results = (events: AgentEvent[]) => of(events, 'turn.result');
const arg = (agy: FakeAgy, name: string) => agy.args[agy.args.indexOf(name) + 1];

describe('AntigravityAdapter: ход', () => {
  it('обычный ход: init → turn.start → text → turn.result; запуск с нужными флагами', async () => {
    const { adapter, spawns } = setup();
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    await vi.waitFor(() => expect(types(events)).toContain('session.init'));
    expect(session.id).toBe(FAKE_CONVERSATION);

    expect(session.send('hello')).toBe(true);
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(types(events)).toEqual(['session.init', 'turn.start', 'text.delta', 'usage.message', 'turn.result']);
    expect(of(events, 'turn.start')[0]?.prompt).toBe('hello');
    expect(of(events, 'text.delta')[0]?.text).toBe('echo: hello');
    expect(results(events)[0]).toMatchObject({ ok: true, text: 'echo: hello', usage: { input: 100, output: 10, thinking: 4 } });

    const agy = spawns[0] as FakeAgy;
    expect(agy.args.slice(0, 5)).toEqual(['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json']);
    expect(arg(agy, '--model')).toBe('gemini-3.8-flash-medium');
    expect(agy.args).not.toContain('--conversation');
    expect(agy.args).not.toContain('--mode');
    expect(agy.received).toEqual([{ event: 'user', message: { role: 'user', content: 'hello' } }]);
    session.dispose();
  });

  it('модель из опций передаётся agy и попадает в session.init', async () => {
    const { adapter, spawns } = setup();
    const session = await adapter.createSession({ ...OPTIONS, model: 'gemini-3.1-pro-low' });
    expect(arg(spawns[0] as FakeAgy, '--model')).toBe('gemini-3.1-pro-low');
    session.dispose();
  });

  it('очередь: второе сообщение уходит в stdin только после result первого, процесс один', async () => {
    let first: (() => void) | undefined;
    const { adapter, spawns } = setup({}, (agy) => {
      agy.onUser = (text, n) => {
        if (n === 0) first = () => agy.answer(`a:${text}`);
        else agy.answer(`a:${text}`);
      };
      setTimeout(() => agy.init(), 0);
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('one');
    session.send('two');
    await vi.waitFor(() => expect(first).toBeDefined());
    await new Promise((r) => setTimeout(r, 20));
    expect((spawns[0] as FakeAgy).received).toHaveLength(1);
    first?.();
    await vi.waitFor(() => expect(results(events)).toHaveLength(2));
    expect(spawns).toHaveLength(1);
    expect(of(events, 'turn.start').map((s) => s.prompt)).toEqual(['one', 'two']);
    session.dispose();
  });

  it('ход с инструментом и отказом: tool.start/result, permissionDenials', async () => {
    const { adapter } = setup({}, (agy) => {
      agy.onUser = () => {
        agy.step({ state: 'DONE', step_type: 'user_input' });
        agy.step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: '/tmp/x' } } });
        agy.step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', error: { message: 'permission check failed' } } });
        agy.result({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'write_file', display_name: 'WriteToFile' }] });
      };
      setTimeout(() => agy.init(), 0);
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('write');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(of(events, 'tool.result')[0]).toMatchObject({ toolUseId: 'agy-2', isError: true });
    expect(results(events)[0]?.permissionDenials).toEqual([{ toolName: 'Write', toolUseId: 'agy-2' }]);
    session.dispose();
  });

  it('картинки и файлы не отправляются, в журнале предупреждение', async () => {
    const { adapter, spawns, logs } = setup();
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('look', [{ mediaType: 'image/png', data: 'AAAA' }], [{ kind: 'text', path: 'a.txt', data: 'x', size: 1 }]);
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(of(events, 'turn.start')[0]?.images).toBeUndefined();
    expect((spawns[0] as FakeAgy).received[0]).toEqual({ event: 'user', message: { role: 'user', content: 'look' } });
    expect(logs.filter((l) => l.startsWith('warn') && /not supported/.test(l))).toHaveLength(2);
    session.dispose();
  });
});

describe('AntigravityAdapter: Stop и пересоздание процесса', () => {
  const hanging = (agy: FakeAgy) => {
    agy.onUser = () => {
      agy.step({ state: 'DONE', step_type: 'user_input' });
      agy.step({ state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 90' } } });
    };
    setTimeout(() => agy.init(), 0);
  };

  it('interrupt: SIGINT, потомки убиты, ход interrupted, сессия жива; следующий send — новый процесс с --conversation', async () => {
    const killed: [number, string][] = [];
    const { adapter, spawns } = setup(
      {
        listProcesses: async () => [
          { pid: 4242, ppid: 1 },
          { pid: 9001, ppid: 4242 },
          { pid: 9002, ppid: 9001 },
          { pid: 777, ppid: 1 },
        ],
        killPid: (pid, signal) => killed.push([pid, signal]),
      },
      (agy, index) => {
        if (index === 0) hanging(agy);
        else {
          agy.onUser = (text) => agy.answer(`again:${text}`);
          setTimeout(() => agy.init(), 0);
        }
      },
    );
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    await vi.waitFor(() => expect(types(events)).toContain('session.init'));
    session.send('sleep');
    await vi.waitFor(() => expect(types(events)).toContain('tool.start'));

    await session.interrupt();
    const first = spawns[0] as FakeAgy;
    expect(first.signals[0]).toBe('SIGINT');
    expect(killed).toEqual([
      [9001, 'SIGKILL'],
      [9002, 'SIGKILL'],
    ]);
    expect(results(events)).toHaveLength(1);
    expect(results(events)[0]).toMatchObject({ ok: false, interrupted: true, subtype: 'interrupted' });
    expect(of(events, 'tool.result')[0]).toMatchObject({ isError: true, content: 'interrupted' });
    expect(types(events)).not.toContain('session.closed');
    expect(spawns).toHaveLength(1); // лениво: процесс поднимается со следующим send

    session.send('next');
    await vi.waitFor(() => expect(results(events)).toHaveLength(2));
    expect(spawns).toHaveLength(2);
    expect(arg(spawns[1] as FakeAgy, '--conversation')).toBe(FAKE_CONVERSATION);
    expect(results(events)[1]?.text).toBe('again:next');
    // повторный init не дублирует session.init
    expect(of(events, 'session.init')).toHaveLength(1);
    session.dispose();
  });

  it('agy не реагирует на SIGINT: через grace SIGKILL, ход закрывается сессией', async () => {
    const { adapter, spawns } = setup({}, (agy) => {
      hanging(agy);
      agy.ignoreSigint = true;
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('sleep');
    await vi.waitFor(() => expect(types(events)).toContain('tool.start'));
    await session.interrupt();
    expect((spawns[0] as FakeAgy).signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(results(events)[0]).toMatchObject({ interrupted: true, ok: false });
    expect(of(events, 'tool.result')[0]?.isError).toBe(true);
    session.dispose();
  });

  it('send сразу после interrupted-result, пока agy ещё не вышел: ход ждёт остановки и идёт в новый процесс', async () => {
    const { adapter, spawns } = setup({ graceMs: 1000 }, (agy, index) => {
      if (index === 0) {
        hanging(agy);
        // как живой agy: `result` сразу, выход — чуть позже
        agy.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
          agy.signals.push(signal);
          if (agy.exited) return false;
          if (signal === 'SIGKILL') agy.exit(null, 'SIGKILL');
          else if (signal === 'SIGINT') {
            agy.result({ status: 'ERROR', error: 'interrupted', response: '' });
            setTimeout(() => agy.exit(1), 150);
          }
          return true;
        };
      } else {
        agy.onUser = (text) => agy.answer(`again:${text}`);
        setTimeout(() => agy.init(), 0);
      }
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    await vi.waitFor(() => expect(types(events)).toContain('session.init'));
    session.send('sleep');
    await vi.waitFor(() => expect(types(events)).toContain('tool.start'));
    const stopping = session.interrupt();
    await vi.waitFor(() => expect(results(events)).toHaveLength(1), { interval: 2 });
    expect((spawns[0] as FakeAgy).exited).toBe(false);
    session.send('next');
    await stopping;
    await vi.waitFor(() => expect(results(events)).toHaveLength(2));
    expect((spawns[0] as FakeAgy).received).toHaveLength(1);
    expect(spawns).toHaveLength(2);
    expect(arg(spawns[1] as FakeAgy, '--conversation')).toBe(FAKE_CONVERSATION);
    expect(results(events)[1]).toMatchObject({ ok: true, text: 'again:next' });
    session.dispose();
  });

  it('interrupt сбрасывает очередь: второе сообщение не уходит', async () => {
    const { adapter, spawns } = setup({}, hanging);
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('one');
    session.send('two');
    await vi.waitFor(() => expect(types(events)).toContain('tool.start'));
    await session.interrupt();
    expect(spawns).toHaveLength(1);
    expect((spawns[0] as FakeAgy).received).toHaveLength(1);
    expect(of(events, 'turn.start')).toHaveLength(1);
    session.dispose();
  });

  it('interrupt без хода — ничего не делает', async () => {
    const { adapter, spawns } = setup();
    const session = await adapter.createSession(OPTIONS);
    await session.interrupt();
    expect((spawns[0] as FakeAgy).signals).toEqual([]);
    session.dispose();
  });

  it('setModel и setMode: следующий ход идёт в новом процессе с новыми флагами, старый остановлен', async () => {
    const { adapter, spawns } = setup();
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    await vi.waitFor(() => expect(types(events)).toContain('session.init'));
    await session.setModel('gemini-3.1-pro-high');
    await session.setMode('acceptEdits');
    expect(of(events, 'mode.changed')).toEqual([{ type: 'mode.changed', mode: 'acceptEdits' }]);
    expect(spawns).toHaveLength(1);
    session.send('go');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(spawns).toHaveLength(2);
    expect((spawns[0] as FakeAgy).stdinEnded).toBe(true);
    const second = spawns[1] as FakeAgy;
    expect(arg(second, '--model')).toBe('gemini-3.1-pro-high');
    expect(arg(second, '--mode')).toBe('accept-edits');
    expect(arg(second, '--conversation')).toBe(FAKE_CONVERSATION);
    session.dispose();
  });

  it('bypassPermissions без разрешения настроек — как default; с разрешением — флаг agy', async () => {
    const denied = setup();
    const a = await denied.adapter.createSession({ ...OPTIONS, permissionMode: 'bypassPermissions' });
    expect(denied.spawns[0]?.args).not.toContain('--dangerously-skip-permissions');
    a.dispose();
    const allowed = setup();
    const b = await allowed.adapter.createSession({ ...OPTIONS, permissionMode: 'bypassPermissions', allowBypassPermissions: true });
    expect(allowed.spawns[0]?.args).toContain('--dangerously-skip-permissions');
    b.dispose();
    expect(modeArgs('default')).toEqual([]);
    expect(modeArgs('plan')).toEqual(['--mode', 'plan']);
  });
});

describe('AntigravityAdapter: resume, сбои, закрытие', () => {
  it('resumeSession запускает agy с --conversation и отдаёт id сразу', async () => {
    const { adapter, spawns } = setup();
    const session = await adapter.resumeSession('abc-123', OPTIONS);
    expect(session.id).toBe('abc-123');
    expect(arg(spawns[0] as FakeAgy, '--conversation')).toBe('abc-123');
    session.dispose();
  });

  it('смерть процесса посреди хода: turn.result, error fatal, session.closed; send больше не принимается', async () => {
    const { adapter, spawns } = setup({}, (agy) => {
      agy.onUser = () => {
        agy.step({ state: 'DONE', step_type: 'user_input' });
        agy.err('error: something broke');
        agy.exit(3);
      };
      setTimeout(() => agy.init(), 0);
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('x');
    await vi.waitFor(() => expect(types(events)).toContain('session.closed'));
    expect(types(events).slice(-3)).toEqual(['turn.result', 'error', 'session.closed']);
    expect(results(events)[0]?.ok).toBe(false);
    expect(of(events, 'error')[0]).toMatchObject({ fatal: true });
    expect(of(events, 'error')[0]?.message).toMatch(/code 3.*something broke/s);
    expect(of(events, 'session.closed')[0]?.reason).toBe('exit');
    expect(session.send('y')).toBe(false);
    expect(spawns).toHaveLength(1);
  });

  it('agy не запустился (ENOENT): error fatal и session.closed', async () => {
    const { adapter } = setup({}, (agy) => agy.failToStart());
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    await vi.waitFor(() => expect(types(events)).toContain('session.closed'));
    expect(of(events, 'error')[0]?.message).toMatch(/Failed to start agy.*ENOENT/);
  });

  it('result ERROR и выход 1 в простое (неизвестная модель) — не авария: ошибка в ленте, следующий ход поднимает процесс', async () => {
    const { adapter, spawns } = setup({}, (agy, index) => {
      if (index === 0) {
        agy.onUser = () => {
          agy.err('error: invalid model selection');
          agy.result({ status: 'ERROR', error: 'invalid model selection (--model "x")', response: '' });
          agy.exit(1);
        };
      } else {
        agy.onUser = (t) => agy.answer(t);
        setTimeout(() => agy.init(), 0);
      }
    });
    const session = await adapter.createSession({ ...OPTIONS, model: 'x' });
    const events = collect(session);
    session.send('hi');
    await vi.waitFor(() => expect(results(events)).toHaveLength(1));
    expect(results(events)[0]?.errors?.[0]).toMatch(/invalid model/);
    await new Promise((r) => setTimeout(r, 20));
    expect(types(events)).not.toContain('session.closed');
    await session.setModel('gemini-3.8-flash-low');
    session.send('again');
    await vi.waitFor(() => expect(results(events)).toHaveLength(2));
    expect(results(events)[1]?.ok).toBe(true);
    expect(spawns).toHaveLength(2);
    session.dispose();
  });

  it('ERROR-result, а второе сообщение уже в очереди: agy выходит — второй ход в новом процессе, не авария', async () => {
    const { adapter, spawns } = setup({}, (agy, index) => {
      if (index === 0) {
        agy.onUser = () => {
          agy.result({ status: 'ERROR', error: 'input decode failed', response: '' });
          setTimeout(() => agy.exit(1), 50);
        };
      } else agy.onUser = (t) => agy.answer(t);
      setTimeout(() => agy.init(), 0);
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('one');
    session.send('two');
    await vi.waitFor(() => expect(results(events)).toHaveLength(2));
    expect(results(events)[0]?.ok).toBe(false);
    expect(results(events)[1]).toMatchObject({ ok: true, text: 'two' });
    expect((spawns[0] as FakeAgy).received).toHaveLength(1);
    expect(spawns).toHaveLength(2);
    expect(types(events)).not.toContain('session.closed');
    session.dispose();
  });

  it('dispose, пока старый процесс останавливается под смену модели: новый не запускается', async () => {
    const { adapter, spawns } = setup({ graceMs: 100 }, (agy) => {
      agy.holdOnEnd = true;
      agy.onUser = (t) => agy.answer(t);
      setTimeout(() => agy.init(), 0);
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    await vi.waitFor(() => expect(types(events)).toContain('session.init'));
    await session.setModel('gemini-3.8-flash-low');
    session.send('hi');
    await vi.waitFor(() => expect((spawns[0] as FakeAgy).stdinEnded).toBe(true), { interval: 2 });
    session.dispose();
    await new Promise((r) => setTimeout(r, 250));
    expect((spawns[0] as FakeAgy).signals).toContain('SIGKILL');
    expect(spawns).toHaveLength(1);
  });

  it('AGY_ERROR в stderr — нефатальный error с кодом', async () => {
    const { adapter } = setup({}, (agy) => {
      agy.onUser = () => agy.err('AGY_ERROR: {"code":429,"message":"quota exhausted"}');
      setTimeout(() => agy.init(), 0);
    });
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.send('x');
    await vi.waitFor(() => expect(of(events, 'error')).toHaveLength(1));
    expect(of(events, 'error')[0]).toMatchObject({ message: 'quota exhausted', code: '429', fatal: false });
    session.dispose();
  });

  it('dispose: stdin закрыт, session.closed disposed, процесс добит, после — тишина', async () => {
    const { adapter, spawns } = setup();
    const session = await adapter.createSession(OPTIONS);
    const events = collect(session);
    session.dispose();
    expect(of(events, 'session.closed')).toEqual([{ type: 'session.closed', reason: 'disposed' }]);
    await vi.waitFor(() => expect((spawns[0] as FakeAgy).exited).toBe(true));
    expect((spawns[0] as FakeAgy).stdinEnded).toBe(true);
    expect(session.send('x')).toBe(false);
  });

  it('dispose посреди хода: SIGINT', async () => {
    const { adapter, spawns } = setup({}, (agy) => {
      agy.onUser = () => agy.step({ state: 'DONE', step_type: 'user_input' });
      setTimeout(() => agy.init(), 0);
    });
    const session = await adapter.createSession(OPTIONS);
    session.send('x');
    await vi.waitFor(() => expect((spawns[0] as FakeAgy).received).toHaveLength(1));
    session.dispose();
    await vi.waitFor(() => expect((spawns[0] as FakeAgy).exited).toBe(true));
    expect((spawns[0] as FakeAgy).signals).toContain('SIGINT');
  });

  it('нет пути к agy — «не найден»', async () => {
    const adapter = new AntigravityAdapter({ executablePath: () => undefined });
    await expect(adapter.createSession(OPTIONS)).rejects.toThrow('Antigravity CLI (agy) was not found.');
  });

  it('capabilities: модели из agy models, один запрос на адаптер; сбой не кэшируется', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([{ value: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)', supportsEffort: false }]);
    const { adapter } = setup({ listModels: list });
    const s1 = await adapter.createSession(OPTIONS);
    const s2 = await adapter.createSession(OPTIONS);
    expect((await s1.capabilities()).models).toEqual([]);
    expect((await s2.capabilities()).models.map((m) => m.value)).toEqual(['gemini-3.8-flash-low']);
    expect((await s1.capabilities()).models).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect((await s1.capabilities()).commands).toEqual([]);
    s1.dispose();
    s2.dispose();
  });

  it('Claude-специфика — no-op (список и история — sessions.test.ts)', async () => {
    const { adapter } = setup();
    const session = await adapter.createSession(OPTIONS);
    expect(session.respondPermission('t', 'allow')).toBe(false);
    expect(session.compact()).toBe(false);
    expect(await session.contextUsage()).toBeUndefined();
    session.dispose();
  });
});
