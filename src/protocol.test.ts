import { describe, expect, it, vi } from 'vitest';
import {
  isFromWebview,
  isSettingsSection,
  postToHost,
  postToWebview,
  AGENT_EVENT_TYPES,
  SETTINGS_SECTIONS,
} from './protocol';

describe('isSettingsSection', () => {
  it('пропускает только разделы вкладки настроек', () => {
    for (const s of SETTINGS_SECTIONS) expect(isSettingsSection(s)).toBe(true);
    expect(isSettingsSection('nope')).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
    expect(isSettingsSection(['integrations'])).toBe(false);
  });
});

describe('protocol', () => {
  it('принимает известные сообщения webview и отбрасывает мусор', () => {
    expect(isFromWebview({ type: 'ready' })).toBe(true);
    expect(isFromWebview({ type: 'limits.refresh' })).toBe(true);
    expect(isFromWebview({ type: 'task.newChat', taskKey: 'jira:x:A-1' })).toBe(true);
    expect(isFromWebview({ type: 'task.newChat' })).toBe(false);
    // settings.open: раздел необязателен; мусор в поле не делает сообщение невалидным (хост его отбрасывает)
    expect(isFromWebview({ type: 'settings.open' })).toBe(true);
    expect(isFromWebview({ type: 'settings.open', section: 'integrations' })).toBe(true);
    expect(isFromWebview({ type: 'settings.open', section: { evil: 1 } })).toBe(true);
    expect(isFromWebview({ type: 'task.newChat', taskKey: 'x'.repeat(401) })).toBe(false);
    expect(isFromWebview({ type: 'send', sessionId: 's', text: 'привет' })).toBe(true);
    expect(isFromWebview({ type: 'preview.open', path: '/a/x.html' })).toBe(true);
    expect(isFromWebview({ type: 'link.open', url: 'https://claude.ai/artifact/1' })).toBe(true);
    expect(isFromWebview({ type: 'diff.changes', sessionId: 's', toolUseIds: ['t'] })).toBe(true);
    expect(isFromWebview({ type: 'fonts.add', kind: 'code' })).toBe(true);
    expect(isFromWebview({ type: 'fonts.add', kind: 'panels' })).toBe(true);
    expect(isFromWebview({ type: 'fonts.remove', family: 'Onest' })).toBe(true);
    // roadmap 17: Remote Control вкладки
    expect(isFromWebview({ type: 'remote.set', on: true })).toBe(true);
    expect(isFromWebview({ type: 'remote.set', sessionId: 's', on: false })).toBe(true);
    expect(isFromWebview({ type: 'remote.set', on: 'yes' })).toBe(false);
    expect(isFromWebview({ type: 'remote.set' })).toBe(false);
    expect(isFromWebview({ type: 'remote.set', sessionId: 5, on: true })).toBe(false);
    expect(isFromWebview({ type: 'integrations.connect' })).toBe(true);
    expect(isFromWebview({ type: 'integrations.test', instanceId: 'jira-x' })).toBe(true);
    expect(isFromWebview({ type: 'integrations.test' })).toBe(false);
    expect(isFromWebview({ type: 'integrations.disconnect', instanceId: '' })).toBe(false);
    expect(isFromWebview({ type: 'unknown' })).toBe(false);
    expect(isFromWebview({ type: 'toString' })).toBe(false);
    expect(isFromWebview(null)).toBe(false);
    expect(isFromWebview('ready')).toBe(false);
  });

  it('граф агентов (roadmap 11): openGraph, snapshot и действия графа проверяются по полям', () => {
    const graph = {
      title: 'сессия',
      main: { limit: 200_000, used: 1000, state: 'working', turnNo: 2 },
      turns: [{ turnNo: 2, startedAt: 1 }],
      agents: [
        {
          agentId: 'tool-1',
          taskId: 't1',
          description: 'd',
          taskType: 'local_agent',
          background: false,
          status: 'running',
          startedAt: 1,
          turnNo: 2,
          calls: 0,
          segs: [{ id: 's', kind: 'tool', at: 2, state: 'run' }],
        },
      ],
    };
    expect(isFromWebview({ type: 'agents.openGraph' })).toBe(true);
    expect(isFromWebview({ type: 'agents.openGraph', agentId: 'tool-1' })).toBe(true);
    expect(isFromWebview({ type: 'agents.openGraph', agentId: 5 })).toBe(false);
    expect(isFromWebview({ type: 'agents.snapshot', sessionId: 's', graph })).toBe(true);
    expect(isFromWebview({ type: 'agents.snapshot', sessionId: '', graph })).toBe(true);
    expect(isFromWebview({ type: 'agents.snapshot', graph })).toBe(false);
    expect(isFromWebview({ type: 'agents.snapshot', sessionId: 's', graph: {} })).toBe(false);
    expect(
      isFromWebview({
        type: 'agents.snapshot',
        sessionId: 's',
        graph: { ...graph, main: { ...graph.main, state: 'busy' } },
      }),
    ).toBe(false);
    expect(
      isFromWebview({
        type: 'agents.snapshot',
        sessionId: 's',
        graph: { ...graph, agents: [{ ...graph.agents[0], status: 'x' }] },
      }),
    ).toBe(false);
    expect(
      isFromWebview({
        type: 'agents.snapshot',
        sessionId: 's',
        graph: { ...graph, agents: [{ ...graph.agents[0], segs: 'нет' }] },
      }),
    ).toBe(false);
    expect(isFromWebview({ type: 'agent.stop', sessionId: 's', taskId: 't' })).toBe(true);
    expect(isFromWebview({ type: 'agent.stop', taskId: 't' })).toBe(false);
    expect(isFromWebview({ type: 'agent.transcript', sessionId: 's', agentId: 'a', taskId: 't' })).toBe(true);
    expect(isFromWebview({ type: 'agent.transcript', sessionId: 's', taskId: 't' })).toBe(false);
  });

  it('вкладка задачи (roadmap 19, этап 2): запросы проверяются по полям', () => {
    const ok = [
      { type: 'task.refresh' },
      { type: 'task.toComposer', commentId: '50001' },
      { type: 'task.openExternal' },
      { type: 'task.openExternal', attachmentId: '40001' },
      { type: 'task.openExternal', web: true },
      { type: 'task.toComposer' }, // roadmap 20: без commentId — контекст всей задачи
    ];
    for (const m of ok) expect(isFromWebview(m), JSON.stringify(m)).toBe(true);
    const bad = [
      { type: 'task.toComposer', commentId: '' },
      { type: 'task.toComposer', commentId: 5 },
      { type: 'task.toComposer', commentId: 'x'.repeat(201) },
      { type: 'task.openExternal', attachmentId: 5 },
      { type: 'task.openExternal', web: 'yes' },
      { type: 'task.state' }, // это сообщение хоста, от webview не принимается
    ];
    for (const m of bad) expect(isFromWebview(m), JSON.stringify(m)).toBe(false);
  });

  it('вкладка «задача» (roadmap 20): запись от пользователя и ссылки — длины, типы, схемы', () => {
    const ok = [
      { type: 'task.transitions' },
      { type: 'task.transition', transitionId: '31' },
      { type: 'task.comment', body: 'Готово' },
      { type: 'task.comment', body: 'x'.repeat(32_000) },
      { type: 'task.logWork', seconds: 5400, date: '2026-10-09', comment: '' },
      { type: 'task.logWork', seconds: 86_400, date: '2024-02-29', comment: 'x'.repeat(30_000) },
      { type: 'task.openLink', url: 'https://jira.example.test/browse/ABC-1' },
      { type: 'task.openLink', url: 'http://x.test' },
      { type: 'task.openLink', url: 'mailto:a@x.test' },
    ];
    for (const m of ok) expect(isFromWebview(m), JSON.stringify(m).slice(0, 200)).toBe(true);
    const bad = [
      { type: 'task.transition' },
      { type: 'task.transition', transitionId: '' },
      { type: 'task.transition', transitionId: 31 },
      { type: 'task.transition', transitionId: 'x'.repeat(51) },
      { type: 'task.comment' },
      { type: 'task.comment', body: '' },
      { type: 'task.comment', body: '   \n ' },
      { type: 'task.comment', body: 5 },
      { type: 'task.comment', body: 'x'.repeat(32_001) },
      { type: 'task.logWork', seconds: 0, date: '2026-10-09', comment: '' },
      { type: 'task.logWork', seconds: 1.5, date: '2026-10-09', comment: '' },
      { type: 'task.logWork', seconds: 86_401, date: '2026-10-09', comment: '' },
      { type: 'task.logWork', seconds: '60', date: '2026-10-09', comment: '' },
      { type: 'task.logWork', seconds: 60, date: '2026-02-30', comment: '' },
      { type: 'task.logWork', seconds: 60, date: '09.10.2026', comment: '' },
      { type: 'task.logWork', seconds: 60, date: '2026-10-09' },
      { type: 'task.logWork', seconds: 60, date: '2026-10-09', comment: 'x'.repeat(30_001) },
      { type: 'task.openLink' },
      { type: 'task.openLink', url: '' },
      { type: 'task.openLink', url: 'javascript:alert(1)' },
      { type: 'task.openLink', url: 'JavaScript:alert(1)' },
      { type: 'task.openLink', url: ' javascript:alert(1)' },
      { type: 'task.openLink', url: 'file:///etc/passwd' },
      { type: 'task.openLink', url: 'vscode://ms-vscode.x/y' },
      { type: 'task.openLink', url: 'command:workbench.action.terminal.new' },
      { type: 'task.openLink', url: 'data:text/html,<script>1</script>' },
      { type: 'task.openLink', url: '/relative/path' },
      { type: 'task.openLink', url: `https://x.test/${'a'.repeat(4000)}` },
      { type: 'task.openLink', url: 7 },
      { type: 'task.action', kind: 'comment', ok: true }, // сообщение хоста, от webview не принимается
    ];
    for (const m of bad) expect(isFromWebview(m), JSON.stringify(m).slice(0, 200)).toBe(false);
  });

  it('вкладка «код» (roadmap 24): запросы task.code.* проверяются по полям, пути и ref-ы — без выхода и флагов', () => {
    const SHA = 'abc1234';
    const ok = [
      { type: 'task.code.load' },
      { type: 'task.code.load', force: true },
      { type: 'task.code.commit', root: '/w/r', sha: SHA },
      { type: 'task.code.commit', root: '/w/r', sha: 'a'.repeat(40) },
      { type: 'task.code.diff', req: 1, root: '/w/r', target: { kind: 'commit', sha: SHA, path: 'src/a.ts' } },
      { type: 'task.code.diff', req: 0, root: '/w/r', target: { kind: 'branch', base: 'origin/develop', branch: 'feature/GARM-87', path: 'a.ts' } },
      { type: 'task.code.diff', req: 2, root: '/w/r', target: { kind: 'wip', path: 'dir/..name/a.ts' } },
      { type: 'task.code.prefill', text: 'abc1234 subject' },
      { type: 'task.code.prefill', text: 'x'.repeat(2000) },
      { type: 'task.code.copy', text: SHA },
      { type: 'task.code.copy', text: 'x'.repeat(200) },
    ];
    for (const m of ok) expect(isFromWebview(m), JSON.stringify(m)).toBe(true);
    const diff = (target: unknown, over: Record<string, unknown> = {}) => ({ type: 'task.code.diff', req: 1, root: '/w/r', target, ...over });
    const bad = [
      { type: 'task.code.load', force: 'yes' },
      { type: 'task.code.commit', root: '/w/r' },
      { type: 'task.code.commit', root: '', sha: SHA },
      { type: 'task.code.commit', root: '/w/r', sha: 'abc' },
      { type: 'task.code.commit', root: '/w/r', sha: 'ABC1234' },
      { type: 'task.code.commit', root: '/w/r', sha: '--output=x' },
      { type: 'task.code.commit', root: '/w/r', sha: 'a'.repeat(41) },
      { type: 'task.code.commit', root: 5, sha: SHA },
      diff({ kind: 'commit', sha: SHA, path: '' }),
      diff({ kind: 'commit', sha: SHA, path: '/etc/passwd' }),
      diff({ kind: 'commit', sha: SHA, path: 'C:\\Windows\\x' }),
      diff({ kind: 'commit', sha: SHA, path: '\\\\server\\share' }),
      diff({ kind: 'commit', sha: SHA, path: '../secret' }),
      diff({ kind: 'commit', sha: SHA, path: 'a/../../b' }),
      diff({ kind: 'commit', sha: SHA, path: 'a\\..\\b' }),
      diff({ kind: 'commit', sha: SHA, path: 'a\0b' }),
      diff({ kind: 'commit', path: 'a.ts' }),
      diff({ kind: 'commit', sha: 'nothex!', path: 'a.ts' }),
      diff({ kind: 'branch', base: '--upload-pack=x', branch: 'b', path: 'a.ts' }),
      diff({ kind: 'branch', base: 'b', branch: '-x', path: 'a.ts' }),
      diff({ kind: 'branch', base: 'b', branch: '', path: 'a.ts' }),
      diff({ kind: 'branch', base: 'b', branch: 'x\ny', path: 'a.ts' }),
      diff({ kind: 'branch', base: 'b', path: 'a.ts' }),
      diff({ kind: 'wip' }),
      diff({ kind: 'staged', path: 'a.ts' }),
      diff('wip'),
      diff(null),
      diff({ kind: 'wip', path: 'a.ts' }, { req: '1' }),
      diff({ kind: 'wip', path: 'a.ts' }, { req: 1.5 }),
      diff({ kind: 'wip', path: 'a.ts' }, { req: -1 }),
      diff({ kind: 'wip', path: 'a.ts' }, { root: '' }),
      { type: 'task.code.prefill' },
      { type: 'task.code.prefill', text: '' },
      { type: 'task.code.prefill', text: 'x'.repeat(2001) },
      { type: 'task.code.copy', text: 'x'.repeat(201) },
      { type: 'task.code.copy', text: 5 },
      { type: 'task.code.state', repos: [] }, // сообщение хоста, от webview не принимается
      { type: 'task.code.diff' },
    ];
    for (const m of bad) expect(isFromWebview(m), JSON.stringify(m).slice(0, 200)).toBe(false);
  });

  it('новый чат задачи (roadmap 26): task.newChat с опциями — движок, текст, carry, where, beside', () => {
    const base = { type: 'task.newChat', taskKey: 'jira:x:A-1' };
    expect(
      isFromWebview({
        ...base,
        provider: 'codex',
        prompt: 'продолжи',
        carry: { task: true, summary: true, changes: false },
        where: 'worktree',
        beside: true,
      }),
    ).toBe(true);
    expect(isFromWebview({ ...base, carry: {} })).toBe(true);
    expect(isFromWebview({ ...base, prompt: 'x'.repeat(2000) })).toBe(true);
    expect(isFromWebview({ ...base, prompt: 'x'.repeat(2001) })).toBe(false);
    expect(isFromWebview({ ...base, prompt: 5 })).toBe(false);
    expect(isFromWebview({ ...base, provider: 'gemini' })).toBe(false);
    expect(isFromWebview({ ...base, carry: { task: 'yes' } })).toBe(false);
    expect(isFromWebview({ ...base, carry: { evil: true } })).toBe(false);
    expect(isFromWebview({ ...base, carry: [true] })).toBe(false);
    expect(isFromWebview({ ...base, carry: null })).toBe(false);
    expect(isFromWebview({ ...base, where: 'elsewhere' })).toBe(false);
    expect(isFromWebview({ ...base, beside: 'yes' })).toBe(false);
  });

  it('вкладка «git» (roadmap 12): запросы проверяются по полям', () => {
    const ok = [
      { type: 'git.watch', on: true },
      { type: 'git.stage', root: '/w', paths: ['a.ts'] },
      { type: 'git.unstage', root: '/w', paths: ['a.ts', 'b.ts'] },
      { type: 'git.discard', root: '/w', paths: ['a.ts'] },
      { type: 'git.commit', roots: ['/w', '/w/b'], message: 'm', amend: false, push: true },
      { type: 'git.commit', roots: ['/w'], message: 'm', amend: true, push: false, all: true },
      { type: 'git.sync', op: 'fetch' },
      { type: 'git.sync', root: '/w', op: 'push' },
      { type: 'git.branch', root: '/w' },
      { type: 'git.open', root: '/w', path: 'a.ts', staged: false },
      { type: 'git.openFile', root: '/w', path: 'a.ts' },
      { type: 'git.openRepository' },
      { type: 'git.message', roots: ['/w', '/w/b'] },
    ];
    for (const m of ok) expect(isFromWebview(m), JSON.stringify(m)).toBe(true);
    const bad = [
      { type: 'git.watch' },
      { type: 'git.stage', root: '/w', paths: [] },
      { type: 'git.stage', root: '/w', paths: 'a.ts' },
      { type: 'git.unstage', paths: ['a.ts'] },
      { type: 'git.discard', root: '/w', paths: [1] },
      { type: 'git.commit', roots: [], message: 'm', amend: false, push: false },
      { type: 'git.commit', roots: ['/w'], message: 'm', amend: false },
      { type: 'git.commit', roots: ['/w'], message: 'm', amend: false, push: false, all: 'yes' },
      { type: 'git.sync', op: 'rebase' },
      { type: 'git.sync', root: 1, op: 'fetch' },
      { type: 'git.branch' },
      { type: 'git.open', root: '/w', path: 'a.ts' },
      { type: 'git.openFile', root: '/w' },
      { type: 'git.message', roots: [] },
      { type: 'git.message', roots: '/w' },
      { type: 'git.status' },
    ];
    for (const m of bad) expect(isFromWebview(m), JSON.stringify(m)).toBe(false);
  });

  it('sessions.update несёт группы задач и метку task у строки (roadmap 19)', () => {
    const post = vi.fn().mockResolvedValue(true);
    const msg = {
      type: 'sessions.update' as const,
      sessions: [
        { id: 's1', title: 'чат', turns: 1, state: 'idle' as const, updatedAt: 1, task: { key: 'K-1', title: 'Фикс' } },
      ],
      tasks: [
        { taskKey: 'jira:a:K-1', meta: { key: 'K-1', instanceId: 'a', title: 'Фикс', url: '' }, sessionIds: ['s1'] },
      ],
    };
    postToWebview({ postMessage: post }, msg);
    expect(post).toHaveBeenCalledWith(msg);
  });

  it('обёртки postMessage передают сообщение как есть', () => {
    const toWebview = vi.fn().mockResolvedValue(true);
    postToWebview({ postMessage: toWebview }, { type: 'init', surface: 'chat', version: '0.0.1' });
    expect(toWebview).toHaveBeenCalledWith({ type: 'init', surface: 'chat', version: '0.0.1' });

    const toHost = vi.fn();
    postToHost({ postMessage: toHost }, { type: 'ready' });
    expect(toHost).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('список событий этапа 2 без дублей', () => {
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
  });
});
