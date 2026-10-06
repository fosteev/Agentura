import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { CodexApprovals } from './approvals';
import type { FileUpdateChange } from './protocol';

function setup(changes: Record<string, FileUpdateChange[]> = {}) {
  const events: AgentEvent[] = [];
  const responses: { id: unknown; result?: unknown; error?: { message: string; code?: number } }[] = [];
  const logs: string[] = [];
  const broker = new CodexApprovals({
    emit: (e) => events.push(e),
    respond: (id, result) => responses.push({ id, result }),
    respondError: (id, message, code) => responses.push({ id, error: { message, ...(code !== undefined ? { code } : {}) } }),
    log: (level, message) => logs.push(`${level}: ${message}`),
    changesOf: (itemId) => changes[itemId],
  });
  return { broker, events, responses, logs };
}
const request = (e: AgentEvent[]) => e.find((x) => x.type === 'permission.request') as Extract<AgentEvent, { type: 'permission.request' }>;
const resolved = (e: AgentEvent[]) => e.filter((x) => x.type === 'permission.resolved');

// форма запроса — живая запись codex-cli 0.160.0 (путь и id заменены)
const COMMAND = {
  kind: 'command',
  threadId: 'thr',
  turnId: 'turn-1',
  itemId: 'exec-1',
  startedAtMs: 1,
  environmentId: 'local',
  command: '/bin/zsh -lc ls',
  cwd: '/work',
  commandActions: [{ type: 'listFiles', command: 'ls', path: null }],
  proposedExecpolicyAmendment: ['ls'],
  availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } }, 'cancel'],
};

describe('команда', () => {
  it('permission.request: Bash, команда без обёртки; toolUseId — id запроса', () => {
    const { broker, events } = setup();
    broker.handle(0, 'item/commandExecution/requestApproval', COMMAND);
    expect(request(events)).toMatchObject({ toolUseId: '0', toolName: 'Bash', input: { command: 'ls' } });
    expect(broker.size).toBe(1);
  });

  it('allow → accept, ответ с тем же id; permission.resolved allow/user', () => {
    const { broker, events, responses } = setup();
    broker.handle(7, 'item/commandExecution/requestApproval', COMMAND);
    expect(broker.respondPermission('7', 'allow')).toBe(true);
    expect(responses).toEqual([{ id: 7, result: { decision: 'accept' } }]);
    expect(resolved(events)).toEqual([{ type: 'permission.resolved', toolUseId: '7', decision: 'allow', by: 'user' }]);
    expect(broker.size).toBe(0);
    expect(broker.respondPermission('7', 'allow')).toBe(false);
  });

  it('deny → decline (живой сервер принимает его и без записи в availableDecisions)', () => {
    const { broker, events, responses } = setup();
    broker.handle(1, 'item/commandExecution/requestApproval', COMMAND);
    broker.respondPermission('1', 'deny');
    expect(responses).toEqual([{ id: 1, result: { decision: 'decline' } }]);
    expect(resolved(events)).toMatchObject([{ decision: 'deny', by: 'user' }]);
  });

  it('«всегда»: сессионного решения в списке нет — постоянное правило Codex из списка, с честной пометкой', () => {
    const { broker, events, responses } = setup();
    broker.handle(2, 'item/commandExecution/requestApproval', COMMAND);
    expect(request(events)).toMatchObject({
      canAlwaysAllow: true,
      always: { rules: ['Bash(ls:*)'], destination: 'codexRules' },
    });
    broker.respondPermission('2', 'allow-always');
    expect(responses).toEqual([
      { id: 2, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } } } },
    ]);
  });

  it('«всегда»: acceptForSession в списке (или списка нет) — сессионное решение', () => {
    const { broker, events, responses } = setup();
    broker.handle(3, 'item/commandExecution/requestApproval', { ...COMMAND, availableDecisions: ['accept', 'acceptForSession', 'cancel'] });
    expect(request(events)).toMatchObject({ canAlwaysAllow: true, always: { destination: 'session' } });
    broker.respondPermission('3', 'allow-always');
    expect(responses[0]).toEqual({ id: 3, result: { decision: 'acceptForSession' } });
    const noList: Record<string, unknown> = { ...COMMAND };
    delete noList['availableDecisions'];
    broker.handle(4, 'item/commandExecution/requestApproval', noList);
    broker.respondPermission('4', 'allow-always');
    expect(responses[1]).toEqual({ id: 4, result: { decision: 'acceptForSession' } });
  });

  it('«всегда» недоступно, если в списке нет ни сессионного, ни постоянного решения', () => {
    const { broker, events, responses } = setup();
    broker.handle(5, 'item/commandExecution/requestApproval', {
      ...COMMAND,
      proposedExecpolicyAmendment: null,
      availableDecisions: ['accept', 'cancel'],
    });
    expect(request(events)).toMatchObject({ canAlwaysAllow: false });
    expect(request(events).always).toBeUndefined();
    // кнопки нет, но если «всегда» всё же пришло — это обычное разрешение, а не выдуманное правило
    broker.respondPermission('5', 'allow-always');
    expect(responses).toEqual([{ id: 5, result: { decision: 'accept' } }]);
  });

  it('writeStdin — тот же Bash, с пометкой', () => {
    const { broker, events } = setup();
    broker.handle(6, 'item/commandExecution/requestApproval', { ...COMMAND, kind: 'writeStdin', command: null });
    expect(request(events)).toMatchObject({ toolName: 'Bash', description: expect.stringMatching(/stdin|input/) });
  });
});

describe('правка файлов', () => {
  const add: FileUpdateChange = { path: '/work/a.txt', kind: { type: 'add' }, diff: 'hi\n' };
  const update: FileUpdateChange = {
    path: '/work/b.txt',
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,3 +1,3 @@\n line1\n-line2\n+line two\n line3\n',
  };
  const params = { threadId: 'thr', turnId: 'turn-1', itemId: 'fc-1', startedAtMs: 1, reason: null, grantRoot: null };

  it('создание: Write с превью write; «принимать правки» → acceptForSession', () => {
    const { broker, events, responses } = setup({ 'fc-1': [add] });
    broker.handle(0, 'item/fileChange/requestApproval', params);
    expect(request(events)).toMatchObject({
      toolName: 'Write',
      input: { file_path: '/work/a.txt' },
      diff: { kind: 'write', filePath: '/work/a.txt', content: 'hi\n' },
      canAlwaysAllow: true,
      always: { mode: 'acceptEdits' },
    });
    broker.respondPermission('0', 'allow-edits');
    expect(responses).toEqual([{ id: 0, result: { decision: 'acceptForSession' } }]);
  });

  it('правка: Edit с превью edit из ханков; allow — accept', () => {
    const { broker, events, responses } = setup({ 'fc-1': [update] });
    broker.handle(1, 'item/fileChange/requestApproval', params);
    expect(request(events)).toMatchObject({
      toolName: 'Edit',
      diff: { kind: 'edit', oldText: 'line1\nline2\nline3', newText: 'line1\nline two\nline3' },
    });
    broker.respondPermission('1', 'allow');
    expect(responses).toEqual([{ id: 1, result: { decision: 'accept' } }]);
  });

  it('несколько файлов — без превью, список в описании; deny → decline', () => {
    const { broker, events, responses } = setup({ 'fc-1': [add, update] });
    broker.handle(2, 'item/fileChange/requestApproval', { ...params, reason: 'extra access', grantRoot: '/work' });
    const e = request(events);
    expect(e.diff).toBeUndefined();
    expect(e.description).toBe('/work/a.txt, /work/b.txt');
    expect(e.reason).toMatch(/extra access.*\/work/);
    broker.respondPermission('2', 'deny');
    expect(responses).toEqual([{ id: 2, result: { decision: 'decline' } }]);
  });

  it('правки неизвестны (нет item/started) — карточка без файла, ответ работает', () => {
    const { broker, events, responses } = setup();
    broker.handle(3, 'item/fileChange/requestApproval', params);
    expect(request(events)).toMatchObject({ toolName: 'Edit', input: {} });
    broker.respondPermission('3', 'allow');
    expect(responses).toEqual([{ id: 3, result: { decision: 'accept' } }]);
  });

  it('список решений без acceptForSession — «всегда» нет, превью без кнопки «принимать правки» тоже', () => {
    const { broker, events } = setup({ 'fc-1': [add] });
    broker.handle(4, 'item/fileChange/requestApproval', { ...params, availableDecisions: ['accept', 'cancel'] });
    expect(request(events)).toMatchObject({ canAlwaysAllow: false });
    expect(request(events).diff).toBeUndefined();
  });
});

describe('item/permissions/requestApproval', () => {
  const params = {
    threadId: 'thr',
    turnId: 'turn-1',
    itemId: 'p-1',
    cwd: '/work',
    reason: 'needs the network',
    permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/data'] } },
  };

  it('allow выдаёт запрошенное на ход; «всегда» — на сессию; отказ — пустой grant', () => {
    const { broker, events, responses } = setup();
    broker.handle(0, 'item/permissions/requestApproval', params);
    expect(request(events)).toMatchObject({
      toolName: 'Permissions',
      reason: 'needs the network',
      description: 'network · write /data',
      canAlwaysAllow: true,
    });
    broker.respondPermission('0', 'allow');
    broker.handle(1, 'item/permissions/requestApproval', params);
    broker.respondPermission('1', 'allow-always');
    broker.handle(2, 'item/permissions/requestApproval', params);
    broker.respondPermission('2', 'deny');
    const grant = { network: { enabled: true }, fileSystem: { read: null, write: ['/data'] } };
    expect(responses).toEqual([
      { id: 0, result: { permissions: grant, scope: 'turn' } },
      { id: 1, result: { permissions: grant, scope: 'session' } },
      { id: 2, result: { permissions: {}, scope: 'turn' } },
    ]);
  });

  it('запрос без network (null) не выдаёт сеть', () => {
    const { broker, responses } = setup();
    broker.handle(0, 'item/permissions/requestApproval', { ...params, permissions: { network: null, fileSystem: { read: ['/r'], write: null } } });
    broker.respondPermission('0', 'allow');
    expect(responses[0]!.result).toEqual({ permissions: { fileSystem: { read: ['/r'], write: null } }, scope: 'turn' });
  });

  it('entries (новая форма fileSystem) видны в карточке; незнакомые поля не выдаются', () => {
    const { broker, events, responses } = setup();
    const entries = [
      { path: { type: 'special', value: { kind: 'root' } }, access: 'write' },
      { path: { type: 'path', path: '/data' }, access: 'read' },
    ];
    broker.handle(0, 'item/permissions/requestApproval', {
      ...params,
      permissions: { network: null, fileSystem: { read: null, write: null, entries, globScanMaxDepth: 9, future: true } },
    });
    expect(request(events)).toMatchObject({ description: 'write / (root) · read /data', canAlwaysAllow: true });
    broker.respondPermission('0', 'allow');
    expect(responses[0]!.result).toEqual({ permissions: { fileSystem: { read: null, write: null, entries } }, scope: 'turn' });
  });
});

describe('команда: сетевой доступ и stdin', () => {
  it('сетевой запрос без команды — карточка называет хост, а не пустой блок', () => {
    const { broker, events } = setup();
    broker.handle(0, 'item/commandExecution/requestApproval', {
      ...COMMAND,
      command: null,
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    });
    expect(request(events)).toMatchObject({ input: { command: 'network access to example.com (https)' } });
  });

  it('writeStdin и сеть при команде — пояснение в input.description (его показывает карточка команды)', () => {
    const { broker, events } = setup();
    broker.handle(0, 'item/commandExecution/requestApproval', {
      ...COMMAND,
      kind: 'writeStdin',
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    });
    expect(request(events)).toMatchObject({
      input: { command: 'ls', description: 'send input to a running process · network access to example.com (https)' },
    });
  });
});

describe('вопросы item/tool/requestUserInput', () => {
  const params = {
    threadId: 'thr',
    turnId: 'turn-1',
    itemId: 'q-1',
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      { id: 'q1', header: 'Mode', question: 'Which mode?', isOther: true, isSecret: false, options: [{ label: 'Fast', description: 'quick' }, { label: 'Slow', description: '' }] },
      { id: 'q2', header: 'Name', question: 'Project name?', isOther: true, isSecret: false, options: null },
    ],
  };

  it('question.request по текущей карточке; ответ уходит по id вопроса', () => {
    const { broker, events, responses } = setup();
    broker.handle(9, 'item/tool/requestUserInput', params);
    const q = events.find((e) => e.type === 'question.request') as Extract<AgentEvent, { type: 'question.request' }>;
    expect(q.toolUseId).toBe('9');
    expect(q.questions).toEqual([
      { question: 'Which mode?', header: 'Mode', options: [{ label: 'Fast', description: 'quick' }, { label: 'Slow' }], multiSelect: false },
      { question: 'Project name?', header: 'Name', options: [], multiSelect: false },
    ]);
    expect(broker.answerQuestion('9', { 'Which mode?': 'Fast', 'Project name?': 'agentura' })).toBe(true);
    expect(responses).toEqual([{ id: 9, result: { answers: { q1: { answers: ['Fast'] }, q2: { answers: ['agentura'] } } } }]);
    expect(resolved(events)).toMatchObject([{ toolUseId: '9', decision: 'allow', by: 'user' }]);
  });

  it('отказ по вопросу — пустые ответы; разрешение (не ответ) на вопрос не принимается', () => {
    const { broker, responses, events } = setup();
    broker.handle(9, 'item/tool/requestUserInput', params);
    expect(broker.respondPermission('9', 'allow')).toBe(false);
    expect(broker.respondPermission('9', 'deny')).toBe(true);
    expect(responses).toEqual([{ id: 9, result: { answers: {} } }]);
    expect(resolved(events)).toMatchObject([{ decision: 'deny', by: 'user' }]);
  });

  it('секретный ввод не собираем: ошибка ответом и видимая ошибка в ленте', () => {
    const { broker, events, responses } = setup();
    broker.handle(10, 'item/tool/requestUserInput', { ...params, questions: [{ ...params.questions[0]!, isSecret: true }] });
    expect(responses).toMatchObject([{ id: 10, error: { code: -32601 } }]);
    expect(events).toMatchObject([{ type: 'error', fatal: false, code: 'unsupported_request' }]);
    expect(broker.size).toBe(0);
  });
});

describe('неизвестное и закрытие', () => {
  it('неизвестный метод — ошибка -32601, лог и видимая ошибка; не виснет', () => {
    const { broker, events, responses, logs } = setup();
    broker.handle(11, 'item/unknown/request', {});
    expect(responses).toEqual([{ id: 11, error: { message: 'Method not supported: item/unknown/request', code: -32601 } }]);
    expect(logs.some((l) => /item\/unknown\/request/.test(l))).toBe(true);
    expect(events).toMatchObject([{ type: 'error', fatal: false, code: 'unsupported_request' }]);
  });

  it('MCP elicitation — отказ по схеме и видимая ошибка', () => {
    const { broker, events, responses } = setup();
    broker.handle(12, 'mcpServer/elicitation/request', {});
    expect(responses).toEqual([{ id: 12, result: { action: 'decline', content: null, _meta: null } }]);
    expect(events).toMatchObject([{ type: 'error', code: 'unsupported_request' }]);
  });

  it('битые params не оставляют запрос без ответа', () => {
    const { broker, responses } = setup();
    broker.handle(13, 'item/tool/requestUserInput', null);
    expect(responses).toMatchObject([{ id: 13, error: {} }]);
  });

  it('serverRequest/resolved от сервера снимает карточку (abort); наш собственный ответ не даёт второго события', () => {
    const { broker, events } = setup();
    broker.handle(1, 'item/commandExecution/requestApproval', COMMAND);
    broker.handle(2, 'item/commandExecution/requestApproval', COMMAND);
    broker.respondPermission('1', 'allow');
    broker.resolved(1);
    broker.resolved(2);
    expect(resolved(events)).toEqual([
      { type: 'permission.resolved', toolUseId: '1', decision: 'allow', by: 'user' },
      { type: 'permission.resolved', toolUseId: '2', decision: 'deny', by: 'abort' },
    ]);
  });

  it('cancelAll (Stop): ответ cancel на команду/файл, пустой grant, пустые ответы — и abort-события', () => {
    const { broker, events, responses } = setup();
    broker.handle(1, 'item/commandExecution/requestApproval', COMMAND);
    broker.handle(2, 'item/fileChange/requestApproval', { threadId: 't', turnId: 'turn-1', itemId: 'f' });
    broker.handle(3, 'item/permissions/requestApproval', { threadId: 't', turnId: 'turn-1', itemId: 'p', cwd: '/', reason: null, permissions: {} });
    broker.handle(4, 'item/tool/requestUserInput', { threadId: 't', turnId: 'turn-1', itemId: 'q', isBlocking: true, autoResolutionMs: null, questions: [] });
    broker.cancelAll();
    expect(responses).toEqual([
      { id: 1, result: { decision: 'cancel' } },
      { id: 2, result: { decision: 'cancel' } },
      { id: 3, result: { permissions: {}, scope: 'turn' } },
      { id: 4, result: { answers: {} } },
    ]);
    expect(resolved(events).map((e) => [(e as { toolUseId: string }).toolUseId, (e as { by: string }).by])).toEqual([
      ['1', 'abort'],
      ['2', 'abort'],
      ['3', 'abort'],
      ['4', 'abort'],
    ]);
    expect(broker.size).toBe(0);
  });

  it('dropAll — без ответа (процесса уже нет), снимает все карточки', () => {
    const { broker, events, responses } = setup();
    broker.handle(1, 'item/commandExecution/requestApproval', COMMAND);
    broker.handle(2, 'item/commandExecution/requestApproval', { ...COMMAND, turnId: 'turn-2' });
    broker.dropAll();
    expect(broker.size).toBe(0);
    expect(responses).toEqual([]);
    expect(resolved(events)).toHaveLength(2);
  });

  it('ошибка записи ответа при cancelAll не мешает снять остальные', () => {
    const events: AgentEvent[] = [];
    const broker = new CodexApprovals({
      emit: (e) => events.push(e),
      respond: () => {
        throw new Error('stdin closed');
      },
      respondError: () => {},
      log: () => {},
      changesOf: () => undefined,
    });
    broker.handle(1, 'item/commandExecution/requestApproval', COMMAND);
    broker.handle(2, 'item/commandExecution/requestApproval', COMMAND);
    broker.cancelAll();
    expect(resolved(events)).toHaveLength(2);
  });
});

describe('устойчивость', () => {
  it('префикс сессии в toolUseId; resolved от сервера находит карточку по id запроса', () => {
    const events: AgentEvent[] = [];
    const broker = new CodexApprovals(
      { emit: (e) => events.push(e), respond: () => {}, respondError: () => {}, log: () => {}, changesOf: () => undefined },
      'codex-2:',
    );
    broker.handle(0, 'item/commandExecution/requestApproval', COMMAND);
    expect(request(events)).toMatchObject({ toolUseId: 'codex-2:0' });
    expect(broker.respondPermission('0', 'allow')).toBe(false);
    broker.resolved(0);
    expect(resolved(events)).toMatchObject([{ toolUseId: 'codex-2:0', by: 'abort' }]);
  });

  it('битый запрос после постановки в pending: один ответ-ошибка, Stop второго не шлёт', () => {
    const { broker, responses } = setup({ 'fc-1': [{ path: '/a', kind: null, diff: '' } as unknown as FileUpdateChange] });
    broker.handle(4, 'item/fileChange/requestApproval', { threadId: 't', turnId: 'turn-1', itemId: 'fc-1', startedAtMs: 1 });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 4, error: {} });
    broker.cancelAll();
    expect(responses).toHaveLength(1);
    expect(broker.size).toBe(0);
  });
});
