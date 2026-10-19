import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changesText,
  CHANGES_COMMITS,
  handoffFile,
  handoffInput,
  handoffNames,
  mainRepoDir,
  newChatOptions,
  publicNewChatOptions,
  worktreeBranch,
  worktreeCwd,
  worktreeDir,
  worktreeN,
  worktreeRepo,
} from './handoff';
import { buildPrompt } from '../../shared/prompt';
import type { CodeRepo } from '../../shared/task';

describe('handoffInput', () => {
  it('реплики, ответы (дельты склеены), инструменты с путём/командой; блок контекста и субагенты не входят', () => {
    const prompt = buildPrompt('почини логин', [{ kind: 'file', path: 'src/a.ts' }]);
    // поля сверх `HandoffEvent` — как у настоящих `AgentEvent`
    const events = [
      { type: 'turn.start', prompt, at: 1 },
      { type: 'text.delta', messageId: 'm1', text: 'Смотрю ' },
      { type: 'text.delta', messageId: 'm1', text: 'код.' },
      { type: 'tool.start', toolUseId: 't1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x' } },
      { type: 'tool.result', toolUseId: 't1', output: 'большой вывод' },
      { type: 'tool.start', toolUseId: 't2', name: 'Bash', input: { command: 'npm\n  test' } },
      { type: 'text.delta', messageId: 's1', text: 'субагент', agentId: 'a1' },
      { type: 'tool.start', toolUseId: 't3', name: 'Read', input: { file_path: 'x' }, agentId: 'a1' },
      { type: 'text.delta', messageId: 'm2', text: 'Готово.' },
      { type: 'turn.start', at: 2 },
    ];
    const text = handoffInput(events);
    expect(text).toBe(
      [
        'User: почини логин',
        'Assistant: Смотрю код.',
        'Tool: Edit src/a.ts',
        'Tool: Bash npm test',
        'Assistant: Готово.',
      ].join('\n\n'),
    );
    expect(text).not.toContain('большой вывод');
    expect(text).not.toContain('[Agentura');
  });

  it('длинная история — последние символы с пометкой, с начала строки', () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ type: 'turn.start', prompt: `сообщение ${i} ${'x'.repeat(50)}` }));
    const text = handoffInput(events, 500);
    expect(text.startsWith('[…earlier part of the chat omitted]\nUser: ')).toBe(true);
    expect(text).toContain('сообщение 49');
    expect(text).not.toContain('сообщение 0 ');
    expect(text.length).toBeLessThanOrEqual(540);
  });

  it('склеенные сообщения хода (`prompts`) — каждое отдельно, у каждого свой блок контекста отрезан', () => {
    const a = buildPrompt('первое', [{ kind: 'file', path: 'src/a.ts' }]);
    const b = buildPrompt('второе', [{ kind: 'file', path: 'src/b.ts' }]);
    const events = [{ type: 'turn.start', prompt: `${a}\n\n${b}`, prompts: [a, b], at: 1 }];
    const text = handoffInput(events);
    expect(text).toBe('User: первое\n\nUser: второе');
    expect(text).not.toContain('[Agentura');
  });

  it('пустая история — пустая строка', () => {
    expect(handoffInput([])).toBe('');
  });
});

describe('файлы передачи', () => {
  it('имена и шапка итога', () => {
    expect(handoffNames('GARM-87')).toEqual({
      task: 'GARM-87.md',
      summary: 'GARM-87-handoff.md',
      changes: 'GARM-87-changes.md',
    });
    expect(handoffFile('Логин', 'codex', ' итог \n')).toBe('# Handoff from chat «Логин» (codex)\n\nитог\n');
  });

  it('изменения: ветка → база, коммиты (до 20), незакоммиченное с ±', () => {
    const at = Date.UTC(2026, 9, 18, 12);
    const repo: CodeRepo = {
      root: '/r/app',
      name: 'app',
      base: 'origin/main',
      branches: [{ name: 'feature/GARM-87', ahead: 3, add: 40, del: 2, files: [] }],
      commits: Array.from({ length: CHANGES_COMMITS + 2 }, (_, i) => ({
        sha: `${i}`.padStart(40, 'a'),
        short: `abc${i}`,
        subject: `GARM-87 шаг ${i}`,
        author: 'Андрей',
        at,
        src: 'key' as const,
      })),
      dirty: [
        { path: 'src/a.ts', status: 'M', add: 5, del: 1, chats: [] },
        { path: 'img.png', status: 'A', binary: true, chats: [] },
      ],
    };
    const text = changesText('GARM-87', [repo, { root: '/r/empty', name: 'empty', branches: [], commits: [], dirty: [] }]);
    expect(text).toContain('# Changes for GARM-87\n\n## app\n\n- branch feature/GARM-87 → origin/main: ahead 3, +40 −2');
    expect(text).toContain('- abc0 GARM-87 шаг 0 (Андрей, 2026-10-18)');
    expect(text).toContain(`- abc${CHANGES_COMMITS - 1} `);
    expect(text).not.toContain(`- abc${CHANGES_COMMITS} `);
    expect(text).toContain('- … 2 more');
    expect(text).toContain('Uncommitted agent edits:\n- M src/a.ts +5 −1\n- A img.png binary');
    expect(text).not.toContain('## empty');
  });

  it('изменений нет — одна строка', () => {
    expect(changesText('GARM-87', [])).toBe(
      '# Changes for GARM-87\n\nNo commits or uncommitted agent edits found for GARM-87.\n',
    );
  });
});

describe('своя worktree', () => {
  it('репозиторий: внешний корень папки, иначе единственный вложенный', () => {
    expect(worktreeRepo('/w/app/src', ['/w/app', '/w/app/src/sub'])).toBe('/w/app');
    expect(worktreeRepo('/w/app', ['/w/app'])).toBe('/w/app');
    expect(worktreeRepo('/w', ['/w/app'])).toBe('/w/app');
    expect(worktreeRepo('/w', ['/w/a', '/w/b'])).toBeUndefined();
    expect(worktreeRepo('/w', [])).toBeUndefined();
    expect(worktreeRepo('/w/application', ['/w/app', '/w/x'])).toBeUndefined();
  });

  it('номер: наименьший ≥ 2 без папки и без локальной ветки', () => {
    expect(worktreeN('app', 'GARM-87', [], [])).toBe(2);
    expect(worktreeN('app', 'GARM-87', ['app-GARM-87-2'], [])).toBe(3);
    expect(worktreeN('app', 'GARM-87', ['APP-garm-87-2'], ['feature/GARM-87-3'])).toBe(4);
    expect(worktreeN('app', 'GARM-87', ['app-GARM-87-3'], ['feature/GARM-87-2', 'feature/GARM-87'])).toBe(4);
    expect(worktreeBranch('GARM-87', 2)).toBe('feature/GARM-87-2');
    expect(worktreeDir('app', 'GARM-87', 2)).toBe('app-GARM-87-2');
  });
});

describe('своя worktree из worktree-чата (Д7)', () => {
  it('основной репозиторий — по --git-common-dir: относительный, абсолютный, пусто', () => {
    expect(mainRepoDir('/w/app', '.git')).toBe('/w/app');
    expect(mainRepoDir('/w/app-K-1-2', '/w/app/.git\n')).toBe('/w/app');
    expect(mainRepoDir('/w/app-K-1-2/', '../app/.git')).toBe('/w/app');
    expect(mainRepoDir('/w/app-K-1-2', '')).toBe('/w/app-K-1-2');
    // голый репозиторий: common dir — он сам
    expect(mainRepoDir('/w/wt', '/w/app.git')).toBe('/w/app.git');
    // имя новой worktree — от основного, а не `app-K-1-2-K-1-3`
    expect(worktreeDir(path.basename(mainRepoDir('/w/app-K-1-2', '/w/app/.git')), 'K-1', 3)).toBe('app-K-1-3');
  });

  it('рабочая папка: та же подпапка, что у источника; корень и вне репо — корень worktree', () => {
    expect(worktreeCwd('/w/app', '/w/app/packages/web', '/w/app-K-1-2')).toBe(path.join('/w/app-K-1-2', 'packages/web'));
    expect(worktreeCwd('/w/app', '/w/app', '/w/app-K-1-2')).toBe('/w/app-K-1-2');
    expect(worktreeCwd('/w/app', '/w/other', '/w/app-K-1-2')).toBe('/w/app-K-1-2');
    expect(worktreeCwd('/w/app-K-1-2', '/w/app-K-1-2/src', '/w/app-K-1-3')).toBe(path.join('/w/app-K-1-3', 'src'));
  });
});

describe('publicNewChatOptions (Д4)', () => {
  it('из аргумента публичной команды — только движок, первое сообщение и «контекст задачи»', () => {
    const raw = {
      provider: 'codex',
      prompt: ' сделай ',
      carry: { task: false, summary: true, changes: true },
      where: 'worktree',
      beside: true,
      from: { provider: 'claude', id: 's1', cwd: '/etc' },
    };
    expect(publicNewChatOptions(raw)).toEqual({ provider: 'codex', prompt: 'сделай', carry: { task: false } });
    expect(publicNewChatOptions({ carry: { summary: true } })).toEqual({});
    expect(publicNewChatOptions('x')).toEqual({});
    // внутренний вызов (вкладка чата) — всё
    expect(newChatOptions(raw)).toMatchObject({ where: 'worktree', beside: true, from: { id: 's1', cwd: '/etc' } });
  });
});

describe('newChatOptions', () => {
  it('поля task.newChat и from; кривые отбрасываются по одному', () => {
    expect(newChatOptions(undefined)).toEqual({});
    expect(newChatOptions('x')).toEqual({});
    expect(
      newChatOptions({
        provider: 'codex',
        prompt: '  продолжи  ',
        carry: { task: true, summary: true },
        where: 'worktree',
        beside: true,
        from: { provider: 'antigravity', id: 's1', cwd: '/w/app' },
      }),
    ).toEqual({
      provider: 'codex',
      prompt: 'продолжи',
      carry: { task: true, summary: true },
      where: 'worktree',
      beside: true,
      from: { provider: 'antigravity', id: 's1', cwd: '/w/app' },
    });
    expect(
      newChatOptions({
        provider: 'gpt',
        prompt: ' ',
        carry: { task: 1 },
        where: 'there',
        beside: 'yes',
        from: { provider: 'claude', cwd: 'rel' },
      }),
    ).toEqual({});
    // без сессии — источник без id; длинный текст режется
    expect(newChatOptions({ from: { provider: 'claude', cwd: '/w', id: '' } })).toEqual({
      from: { provider: 'claude', cwd: '/w' },
    });
    expect(newChatOptions({ prompt: 'я'.repeat(3000) }).prompt).toHaveLength(2000);
  });
});
