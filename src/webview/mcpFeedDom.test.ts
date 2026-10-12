// @vitest-environment jsdom
/**
 * MCP и скиллы в ленте (roadmap 21, этап 2): чип сервера, полоса скилла, счётчики в итоге хода, системная строка
 * по `agentura.mcp.feedStatus`, «отключился» при переходе в сбой, свёрнутый вид, `feedLabels=false`.
 */
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, McpServerInfo } from '../agent/types';
import { initialState, queueUser, seedHistory } from './chatState';
import { feedItems } from './agentsView';
import { feedTurns } from './turnView';
import { Chat } from './components/Chat';
import { initialHud } from './hudState';
import { mcpNote, mcpPrefix, mcpUsage, serverByPrefix, sessionSkills, turnCounts } from './mcpFeed';
import {
  chat,
  dispatchEvent,
  feedStyle,
  handleHostMessage,
  hudState,
  mcpFeedLabels,
  mcpFeedStatus,
  skillFiles,
} from './store';
import * as vscode from './vscode';

const T0 = 1_700_000_000_000;
const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };
const flush = () => new Promise((r) => setTimeout(r, 30));
const mounted: HTMLElement[] = [];
let sent: Record<string, unknown>[] = [];

function mount() {
  const host = document.createElement('div');
  mounted.push(host);
  document.body.append(host);
  render(h(Chat, {}), host);
  return host;
}
const q = <T extends Element = HTMLElement>(host: Element, sel: string) => host.querySelector(sel) as T;
const qa = (host: Element, sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

beforeEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = '';
  sent = [];
  vi.spyOn(vscode, 'send').mockImplementation((m) => void sent.push(m as unknown as Record<string, unknown>));
  chat.value = initialState();
  hudState.value = initialHud();
  feedStyle.value = 'journal';
  mcpFeedLabels.value = true;
  mcpFeedStatus.value = 'failures';
  skillFiles.value = new Set();
});

const srv = (name: string, status: McpServerInfo['status'], error?: string): McpServerInfo => ({
  name,
  status,
  ...(error ? { error } : {}),
});
const status = (servers: McpServerInfo[], at = T0): AgentEvent => ({ type: 'mcp.status', servers, at });
const init = (skills: string[] = ['plan', 'pohuy:pohuy']): AgentEvent => ({
  type: 'session.init',
  sessionId: 's1',
  model: 'm',
  cwd: '/p',
  permissionMode: 'default',
  tools: [],
  slashCommands: [],
  skills,
  agents: [],
  apiKeySource: 'none',
  engineVersion: '1',
});
const tool = (id: string, name: string, input: Record<string, unknown> = {}): AgentEvent[] => [
  { type: 'tool.start', toolUseId: id, name, input },
  { type: 'tool.result', toolUseId: id, isError: false, content: 'ok', durationMs: 100 },
];
const result = (): AgentEvent => ({
  type: 'turn.result',
  ok: true,
  subtype: 'success',
  interrupted: false,
  durationMs: 5000,
  apiDurationMs: 4000,
  numTurns: 1,
  totalCostUsd: 0.01,
  costUsd: 0.01,
  usage,
  permissionDenials: [],
});
function play(events: AgentEvent[]): void {
  let now = T0;
  for (const e of events) dispatchEvent(e, (now += 10));
}

/** Ход: Skill, три вызова MCP (один — к упавшему webstorm), Read, итог. */
function turn(prompt = 'сделай'): AgentEvent[] {
  return [
    { type: 'turn.start', at: T0, prompt },
    ...tool('k1', 'Skill', { skill: 'plan' }),
    ...tool('m1', 'mcp__serena__find_symbol', { name_path: 'A/b' }),
    ...tool('m2', 'mcp__serena__find_symbol', { name_path: 'C' }),
    ...tool('m3', 'mcp__webstorm__get_file_problems', { path: 'a.ts' }),
    ...tool('r1', 'Read', { file_path: '/p/a.ts' }),
    result(),
  ];
}

describe('чистые функции', () => {
  it('mcpPrefix: как CLI делает префикс инструмента', () => {
    expect(mcpPrefix('claude.ai Gmail')).toBe('claude_ai_Gmail');
    expect(mcpPrefix('serena')).toBe('serena');
    expect(mcpPrefix('my-srv_2')).toBe('my-srv_2');
    // коннекторы claude.ai: `_+` схлопывается, края срезаются (как в SDK); у остальных — нет
    expect(mcpPrefix('claude.ai Foo & Bar')).toBe('claude_ai_Foo_Bar');
    expect(mcpPrefix('a & b')).toBe('a___b');
    // Claude даёт нормализованный префикс, Codex — имя как есть: находим в обоих случаях
    const list = [srv('claude.ai Gmail', 'failed')];
    expect(serverByPrefix(list, 'claude_ai_Gmail')?.name).toBe('claude.ai Gmail');
    expect(serverByPrefix(list, 'claude.ai Gmail')?.name).toBe('claude.ai Gmail');
    expect(serverByPrefix(list, 'gmail')).toBeUndefined();
  });

  it('mcpNote: первый статус — start; дальше fail только для новых сбоев; пусто — ничего', () => {
    const a = [srv('x', 'connected'), srv('y', 'pending')];
    expect(mcpNote(undefined, [])).toBeUndefined();
    expect(mcpNote(undefined, a)).toMatchObject({ variant: 'start', bad: [] });
    expect(mcpNote(undefined, [srv('x', 'failed', 'boom')])).toMatchObject({ variant: 'start', bad: ['x'] });
    expect(mcpNote(a, [srv('x', 'failed', 'boom'), srv('y', 'pending')])).toMatchObject({ variant: 'fail', bad: ['x'] });
    // pending → failed — тоже сбой, needs-auth — тоже
    expect(mcpNote(a, [srv('x', 'connected'), srv('y', 'needs-auth')])).toMatchObject({ variant: 'fail', bad: ['y'] });
    // тот же сбой повторно, выздоровление, выключение — строки нет
    expect(mcpNote([srv('x', 'failed')], [srv('x', 'failed', 'again')])).toBeUndefined();
    expect(mcpNote([srv('x', 'failed')], [srv('x', 'connected')])).toBeUndefined();
    expect(mcpNote(a, [srv('x', 'disabled'), srv('y', 'pending')])).toBeUndefined();
  });

  it('счётчики и скиллы считаются по ленте, в том числе после пересева из событий', () => {
    const s = seedHistory(initialState(), { sessionId: 's1', skippedTurns: 0 }, [init(), ...turn('/plan x')]);
    const usageMap = mcpUsage(s.rows);
    expect(usageMap.get('serena')!.total).toBe(2);
    expect([...usageMap.get('serena')!.tools]).toEqual([['find_symbol', 2]]);
    expect(usageMap.get('webstorm')!.total).toBe(1);
    // `/plan x` — слэш, затем Skill plan уже учтён (повтор не плодится)
    expect(sessionSkills(s.rows, s.skills)).toEqual([{ name: 'plan', how: 'slash', id: expect.any(Number) }]);
    expect(turnCounts(s.rows)).toEqual({ mcp: 3, skill: 1 });
  });

  it('sessionSkills: вызов агента и /имя; чужое /имя не скилл; сообщение в очереди не считается', () => {
    let s = initialState();
    s = seedHistory(
      s,
      { sessionId: 's1', skippedTurns: 0 },
      [
        init(),
        { type: 'turn.start', at: T0, prompt: '/other что-то' },
        ...tool('k1', 'Skill', { skill: 'pohuy:pohuy' }),
        result(),
      ],
    );
    expect(sessionSkills(s.rows, s.skills).map((x) => [x.name, x.how])).toEqual([['pohuy:pohuy', 'agent']]);
  });
});

describe('метки B в ленте', () => {
  it('чип сервера и op mcp; упавший сервер — красные чип и op; имя из статуса', async () => {
    const host = mount();
    play([init(), status([srv('serena', 'connected'), srv('webstorm', 'failed', 'ECONNREFUSED'), srv('claude.ai Gmail', 'connected')]), ...turn()]);
    play(tool('g1', 'mcp__claude_ai_Gmail__search_threads', { query: 'x' }));
    await flush();
    const rows = qa(host, '.log .e').filter((e) => q(e, '.chip2'));
    expect(rows.map((e) => q(e, '.chip2').textContent)).toEqual(['serena', 'serena', 'webstorm', 'claude.ai Gmail']);
    expect(rows.map((e) => q(e, '.op').textContent)).toEqual(['mcp', 'mcp', 'mcp', 'mcp']);
    const bad = rows[2]!;
    expect(q(bad, '.chip2').className).toContain('bad');
    expect(q(bad, '.op').className).toContain('bad');
    expect(q(rows[0]!, '.chip2').className).not.toContain('bad');
    expect(q(rows[0]!, '.what').textContent).toContain('find_symbol');
    expect(q(rows[0]!, '.what').textContent).toContain('A/b');
  });

  it('полоса скилла: имя, «вызвал агент», ссылка только при skill.files и никогда у плагинного', async () => {
    const host = mount();
    play([init(), { type: 'turn.start', at: T0, prompt: 'go' }, ...tool('k1', 'Skill', { skill: 'plan' }), ...tool('k2', 'Skill', { skill: 'pohuy:pohuy' })]);
    await flush();
    let bars = qa(host, '.log .skrow');
    expect(bars.map((b) => q(b, 'b').textContent)).toEqual(['plan', 'pohuy:pohuy']);
    expect(bars[0]!.textContent).toContain('вызвал агент');
    expect(qa(host, '.skrow a')).toHaveLength(0);
    // хост нашёл файлы у обоих (рассинхрон) — у плагинного ссылки всё равно нет
    handleHostMessage({ type: 'skill.files', names: ['plan', 'pohuy:pohuy'] });
    await flush();
    bars = qa(host, '.log .skrow');
    expect(qa(bars[0]!, 'a')).toHaveLength(1);
    expect(qa(bars[1]!, 'a')).toHaveLength(0);
    qa(bars[0]!, 'a')[0]!.click();
    expect(sent).toContainEqual({ type: 'skill.open', name: 'plan' });
    expect(sent.filter((m) => m['type'] === 'skill.open')).toHaveLength(1);
  });

  it('итог хода: mcp N и скилл N, только ненулевые', async () => {
    const host = mount();
    play([init(), ...turn()]);
    await flush();
    expect(qa(host, '.sum .mx').map((x) => x.textContent)).toEqual(['mcp 3']);
    expect(qa(host, '.sum .sx').map((x) => x.textContent)).toEqual(['скилл 1']);
    play([{ type: 'turn.start', at: T0 + 100, prompt: 'ещё' }, ...tool('r2', 'Read', { file_path: '/p/b.ts' }), result()]);
    await flush();
    const sums = qa(host, '.sum');
    expect(sums).toHaveLength(2);
    expect(q(sums[1]!, '.mx')).toBeNull();
    expect(q(sums[1]!, '.sx')).toBeNull();
  });

  it('feedLabels=false: лента как раньше — без чипов, полос и счётчиков; op от короткого имени', async () => {
    mcpFeedLabels.value = false;
    const host = mount();
    play([init(), status([srv('serena', 'connected')]), ...turn()]);
    await flush();
    expect(qa(host, '.chip2, .skrow, .sum .mx, .sum .sx')).toHaveLength(0);
    const ops = qa(host, '.log .e .op').map((x) => x.textContent);
    expect(ops).toEqual(['skill', 'find_sy', 'find_sy', 'get_fil', 'read']);
    const skill = qa(host, '.log .e').find((e) => q(e, '.op').textContent === 'skill')!;
    expect(q(skill, '.what').textContent).toBe('plan');
  });

  it('folded: в сводке свёрнутого хода «mcp ×3», полосы скиллов видны', async () => {
    feedStyle.value = 'folded';
    const host = mount();
    play([init(), ...turn()]);
    await flush();
    expect(q(host, '.fold .what').textContent).toContain('mcp ×3');
    expect(q(host, '.turn').getAttribute('data-open')).toBe('false');
    expect(q(host, '.turn .skrow')).not.toBeNull();
    // переключение меток пересчитывает сводку
    mcpFeedLabels.value = false;
    await flush();
    expect(q(host, '.fold .what').textContent).not.toContain('mcp ×');
  });

  it('replies и cards: чипы и полосы те же (вид задаёт CSS)', async () => {
    for (const style of ['replies', 'cards'] as const) {
      feedStyle.value = style;
      chat.value = initialState();
      const host = mount();
      play([init(), ...turn()]);
      await flush();
      expect(qa(host, '.steps .e .chip2').length).toBeGreaterThan(0);
      expect(qa(host, '.steps .skrow')).toHaveLength(1);
      expect(host.querySelector('.webview')!.getAttribute('data-feed')).toBe(style);
    }
  });
});

describe('системная строка MCP', () => {
  const list = [srv('serena', 'connected'), srv('webstorm', 'failed', 'ECONNREFUSED'), srv('jira', 'needs-auth')];

  it('failures: при старте только если есть сбой; свёрнута, список раскрывается по клику', async () => {
    const host = mount();
    play([init(), { type: 'turn.start', at: T0, prompt: 'go' }, status(list)]);
    await flush();
    const row = q(host, '.sys.mcp');
    expect(row.textContent).toContain('1 подключён');
    expect(row.textContent).toContain('webstorm не подключился (ECONNREFUSED)');
    expect(row.textContent).toContain('1 ждёт входа');
    expect(q(host, '.sysd')).toBeNull();
    q(row, 'a').click();
    await flush();
    expect(qa(host, '.sysd .srv')).toHaveLength(3);
    // строка стоит внутри хода
    expect(q(host, '.turn .sys.mcp')).not.toBeNull();
  });

  it('failures: без сбоев строки нет; пустой список — тоже', async () => {
    const host = mount();
    play([init(), { type: 'turn.start', at: T0, prompt: 'go' }, status([]), status([srv('serena', 'connected')], T0 + 1)]);
    await flush();
    expect(q(host, '.sys.mcp')).toBeNull();
  });

  it('start: сводка и без сбоев, список раскрыт; off: никогда', async () => {
    mcpFeedStatus.value = 'start';
    const host = mount();
    play([init(), { type: 'turn.start', at: T0, prompt: 'go' }, status([srv('serena', 'connected'), srv('ctx', 'connected')])]);
    await flush();
    expect(q(host, '.sys.mcp').textContent).toContain('2 подключены');
    expect(qa(host, '.sysd .srv')).toHaveLength(2);
    mcpFeedStatus.value = 'off';
    await flush();
    expect(q(host, '.sys.mcp')).toBeNull();
    // настройка применяется к уже накопленным строкам: при failures сводки без сбоев нет, вернули start — снова есть
    mcpFeedStatus.value = 'failures';
    await flush();
    expect(q(host, '.sys.mcp')).toBeNull();
    mcpFeedStatus.value = 'start';
    await flush();
    expect(q(host, '.sys.mcp')).not.toBeNull();
  });

  it('Claude: статус из init раньше turn.start — строка всё равно в ходе реплики, после неё', () => {
    mcpFeedStatus.value = 'start';
    play([init()]);
    chat.value = queueUser(chat.value, 'go');
    play([
      status([srv('serena', 'pending')]),
      { type: 'turn.start', at: T0, prompt: 'go' },
      status([srv('serena', 'connected')], T0 + 1),
    ]);
    const kinds = chat.value.rows.map((r) => (r.kind === 'sys' && r.mcp ? 'mcp' : r.kind));
    expect(kinds.slice(-2)).toEqual(['user', 'mcp']);
    const blocks = feedTurns(feedItems(chat.value.rows));
    const last = blocks.at(-1)!;
    expect(last.kind).toBe('turn');
    expect(JSON.stringify(last)).toContain('"variant":"start"');
  });

  it('«отключился» при переходе connected → failed; повтор того же сбоя строки не даёт', async () => {
    const host = mount();
    play([
      init(),
      { type: 'turn.start', at: T0, prompt: 'go' },
      status([srv('serena', 'connected'), srv('webstorm', 'connected')]),
      result(),
      { type: 'turn.start', at: T0 + 100, prompt: 'ещё' },
      status([srv('serena', 'connected'), srv('webstorm', 'failed', 'closed')], T0 + 200),
      status([srv('serena', 'connected'), srv('webstorm', 'failed', 'closed again')], T0 + 300),
    ]);
    await flush();
    const rows = qa(host, '.sys.mcp');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('webstorm отключился (closed)');
    // во втором ходе, не в первом
    const turns = qa(host, '.turn');
    expect(q(turns[1]!, '.sys.mcp')).not.toBeNull();
    expect(q(turns[0]!, '.sys.mcp')).toBeNull();
  });

  it('старт оседает: init даёт pending, следом failed — одна сводка «не подключился», не «отключился»', async () => {
    const host = mount();
    play([
      init(),
      { type: 'turn.start', at: T0, prompt: 'go' },
      status([srv('serena', 'pending'), srv('webstorm', 'pending')]),
      status([srv('serena', 'connected'), srv('webstorm', 'failed', 'ECONNREFUSED')], T0 + 1),
      status([srv('serena', 'connected'), srv('webstorm', 'failed', 'ECONNREFUSED')], T0 + 2),
    ]);
    await flush();
    const rows = qa(host, '.sys.mcp');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('1 подключён');
    expect(rows[0]!.textContent).toContain('webstorm не подключился (ECONNREFUSED)');
    expect(rows[0]!.textContent).not.toContain('отключился');
    expect(chat.value.rows.filter((r) => r.kind === 'sys' && r.mcp)).toHaveLength(1);
    // start: та же одна строка, уже без «запускаются»
    mcpFeedStatus.value = 'start';
    await flush();
    expect(qa(host, '.sys.mcp')).toHaveLength(1);
    expect(q(host, '.sys.mcp').textContent).not.toContain('запускаются');
  });

  it('после итога хода старт уже не оседает: сбой зависшего сервера — новой строкой', () => {
    play([
      init(),
      { type: 'turn.start', at: T0, prompt: 'go' },
      status([srv('serena', 'connected'), srv('webstorm', 'pending')]),
      result(),
      { type: 'turn.start', at: T0 + 100, prompt: 'ещё' },
      status([srv('serena', 'connected'), srv('webstorm', 'failed')], T0 + 200),
    ]);
    const notes = chat.value.rows.flatMap((r) => (r.kind === 'sys' && r.mcp ? [r.mcp] : []));
    expect(notes.map((n) => n.variant)).toEqual(['start', 'fail']);
    expect(notes[1]!.bad).toEqual(['webstorm']);
  });

  it('в историю не пишется: после пересева первый (повторный) статус только обновляет состояние', () => {
    const s = seedHistory(initialState(), { sessionId: 's1', skippedTurns: 0, mcpReplay: true }, [init(), ...turn()]);
    expect(s.rows.some((r) => r.kind === 'sys' && r.mcp)).toBe(false);
    chat.value = s;
    dispatchEvent(status(list));
    expect(chat.value.rows.some((r) => r.kind === 'sys' && r.mcp)).toBe(false);
    expect(chat.value.mcp?.servers).toEqual(list);
    // а настоящая новость после этого — пишется
    dispatchEvent(status([srv('serena', 'failed', 'x'), srv('webstorm', 'failed'), srv('jira', 'needs-auth')], T0 + 5));
    expect(chat.value.rows.filter((r) => r.kind === 'sys' && r.mcp)).toHaveLength(1);
  });

  it('сессия, открытая из истории (без mcpReplay): первый статус — init движка — пишет строку старта', () => {
    const s = seedHistory(initialState(), { sessionId: 's1', skippedTurns: 0 }, [init(), ...turn()]);
    chat.value = s;
    // у Claude mcp.status из init приходит раньше turn.start
    dispatchEvent(status([srv('serena', 'pending'), srv('webstorm', 'pending')], T0 + 2000));
    dispatchEvent({ type: 'turn.start', at: T0 + 2001, prompt: 'go' });
    dispatchEvent(status([srv('serena', 'connected'), srv('webstorm', 'failed', 'x')], T0 + 2002));
    const notes = chat.value.rows.flatMap((r) => (r.kind === 'sys' && r.mcp ? [r.mcp] : []));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.variant).toBe('start');
    expect(notes[0]!.bad).toEqual(['webstorm']);
  });

  it('новая сессия: состояние MCP сбрасывается вместе с лентой', () => {
    dispatchEvent(status(list));
    expect(chat.value.mcp).toBeDefined();
    handleHostMessage({ type: 'session.reset' });
    expect(chat.value.mcp).toBeUndefined();
  });
});
