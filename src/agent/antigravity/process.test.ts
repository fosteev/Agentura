import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeAgy } from './fakeAgy';
import { AgyProcess, descendantsOf, listProcessesPs, parsePs, type AgyExit, type AgyProcessHandlers } from './process';
import type { AgyEvent } from './protocol';

function handlers() {
  const events: AgyEvent[] = [];
  const errors: { message: string; code?: string }[] = [];
  const stderr: string[] = [];
  const exits: AgyExit[] = [];
  let overflow = 0;
  const h: AgyProcessHandlers = {
    onEvent: (e) => events.push(e),
    onAgyError: (e) => errors.push(e),
    onStderr: (l) => stderr.push(l),
    onOverflow: () => overflow++,
    onExit: (x) => exits.push(x),
  };
  return { h, events, errors, stderr, exits, overflow: () => overflow };
}

describe('NDJSON поток agy', () => {
  it('строки, разорванные по чанкам, и несколько событий в одном чанке', () => {
    const agy = new FakeAgy([]);
    const t = handlers();
    new AgyProcess(agy, t.h);
    const line = '{"event":"result","result":{"status":"SUCCESS"}}';
    agy.stdout.write(line.slice(0, 10));
    agy.stdout.write(`${line.slice(10)}\n${line}\n`);
    agy.stdout.write('garbage\n');
    expect(t.events).toHaveLength(2);
  });

  it('хвост без перевода строки при закрытии тоже разбирается; код выхода и хвост stderr в onExit', async () => {
    const agy = new FakeAgy([]);
    const t = handlers();
    new AgyProcess(agy, t.h);
    agy.stdout.write('{"event":"result","result":{"status":"ERROR","error":"x"}}');
    agy.err('first');
    agy.err('AGY_ERROR: {"message":"m"}');
    agy.exit(1);
    await vi.waitFor(() => expect(t.exits).toHaveLength(1));
    expect(t.events).toHaveLength(1);
    expect(t.exits[0]).toMatchObject({ code: 1, stderrTail: 'first\nAGY_ERROR: {"message":"m"}' });
    expect(t.errors).toEqual([{ message: 'm' }]);
    expect(t.stderr).toEqual(['first', 'AGY_ERROR: {"message":"m"}']);
  });

  it('строка длиннее лимита без перевода строки — onOverflow, поток дальше не читается', () => {
    const agy = new FakeAgy([]);
    const t = handlers();
    new AgyProcess(agy, t.h, { maxLineBytes: 100 });
    agy.stdout.write('x'.repeat(150));
    agy.stdout.write('{"event":"result","result":{"status":"SUCCESS"}}\n');
    expect(t.overflow()).toBe(1);
    expect(t.events).toHaveLength(0);
  });

  it('ошибка запуска (ENOENT) — onExit с error', async () => {
    const agy = new FakeAgy([]);
    const t = handlers();
    new AgyProcess(agy, t.h);
    agy.failToStart('spawn agy ENOENT');
    await vi.waitFor(() => expect(t.exits[0]?.error?.message).toMatch(/ENOENT/));
  });

  it('error у живого процесса (не удался kill) — не выход: процесс жив, onExit не зовётся', () => {
    const agy = new FakeAgy([]);
    const t = handlers();
    const proc = new AgyProcess(agy, t.h);
    agy.emit('error', new Error('kill EPERM'));
    expect(proc.alive).toBe(true);
    expect(t.exits).toEqual([]);
  });
  it('write: строка доходит до stdin; после закрытия — false', async () => {
    const agy = new FakeAgy([]);
    const t = handlers();
    const proc = new AgyProcess(agy, t.h, { graceMs: 10, listProcesses: async () => [] });
    expect(proc.write('{"event":"user","message":{"role":"user","content":"a"}}\n')).toBe(true);
    await proc.stop();
    expect(proc.write('x\n')).toBe(false);
    expect(proc.alive).toBe(false);
  });
});

describe('потомки', () => {
  const rows = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 13, ppid: 10 },
    { pid: 20, ppid: 1 },
  ];
  it('parsePs читает `pid ppid`, пропуская мусор', () => {
    expect(parsePs('  1     0\n 10   1\nPID PPID\n\n')).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
    ]);
  });
  it('descendantsOf: дети и внуки, без самого корня и чужих', () => {
    expect(descendantsOf(rows, 10).sort()).toEqual([11, 12, 13]);
    expect(descendantsOf(rows, 99)).toEqual([]);
  });
  it('после выхода agy потомков не собирает (pid мог достаться чужому); пока жив — только его дерево', async () => {
    const killed: number[] = [];
    let listed = 0;
    const table = [
      { pid: 4242, ppid: 1 },
      { pid: 9001, ppid: 4242 },
      { pid: 777, ppid: 1 },
    ];
    const agy = new FakeAgy([]);
    const proc = new AgyProcess(agy, handlers().h, {
      graceMs: 5,
      listProcesses: async () => (listed++, table),
      killPid: (pid) => killed.push(pid),
    });
    await proc.kill();
    expect(killed).toEqual([9001]);
    killed.length = 0;
    listed = 0;
    await proc.kill();
    await proc.interrupt();
    await proc.stop();
    expect(listed).toBe(0);
    expect(killed).toEqual([]);
  });
  it('agy вышел, пока шёл ps: таблицу не используем', async () => {
    const killed: number[] = [];
    const agy = new FakeAgy([]);
    const proc = new AgyProcess(agy, handlers().h, {
      graceMs: 5,
      listProcesses: async () => {
        agy.exit(0);
        await new Promise((r) => setImmediate(r));
        return [{ pid: 9001, ppid: 4242 }];
      },
      killPid: (pid) => killed.push(pid),
    });
    await proc.interrupt();
    expect(killed).toEqual([]);
  });
  it('listProcessesPs возвращает хотя бы текущий процесс', async () => {
    if (process.platform === 'win32') return;
    const list = await listProcessesPs();
    expect(list.some((r) => r.pid === process.pid)).toBe(true);
  });
});

const posix = process.platform === 'win32' ? describe.skip : describe;

posix('живое убийство дерева', () => {
  it('SIGINT agy, SIGKILL потомка, пережившего agy (своя группа процессов, как у run_command)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentura-agy-test-'));
    const script = join(dir, 'fake.mjs');
    // «agy»: порождает отдельную группу с `sleep`, по SIGINT выходит с 1 — потомок остаётся (как у настоящего)
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
c.unref();
console.log(JSON.stringify({ event: 'init', conversation_id: 'c', init: { model: 'm', child: c.pid } }));
process.on('SIGINT', () => { console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'interrupted' } })); process.exit(1); });
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const t = handlers();
    const proc = new AgyProcess(child, t.h, { graceMs: 3000 });
    let sleeper = 0;
    try {
      await vi.waitFor(() => expect(t.events).toHaveLength(1), { timeout: 5000 });
      sleeper = ((t.events[0] as { init: { child?: number } }).init.child) as number;
      expect(() => process.kill(sleeper, 0)).not.toThrow();
      await proc.interrupt();
      expect(t.events.map((e) => e.event)).toEqual(['init', 'result']);
      expect(t.exits[0]).toMatchObject({ code: 1 });
      await vi.waitFor(
        () => {
          let alive = true;
          try {
            process.kill(sleeper, 0);
          } catch {
            alive = false;
          }
          // zombie до reap'а init-ом не считаем: ждём, пока kill(0) перестанет проходить
          expect(alive).toBe(false);
        },
        { timeout: 3000 },
      );
    } finally {
      try {
        if (sleeper) process.kill(sleeper, 'SIGKILL');
      } catch {
        // уже убит
      }
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
