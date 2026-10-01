import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventOf } from '../types';
import { readTranscriptExtras } from '../../data/transcriptExtras';
import { buildHistory, handBackText, notificationEnd } from './history';
import {
  readSubagentMeta,
  readSubagentRecords,
  subagentEvents,
  subagentFile,
  subagentMarkdown,
  withSubagentTimelines,
} from './subagents';
import {
  AGENTS_SUBAGENTS_DIR,
  AGENTS_TRANSCRIPT,
  agentsParallelMessages,
} from './__fixtures__/agentsParallel';

function ofType<T extends AgentEvent['type']>(events: AgentEvent[], type: T): AgentEventOf<T>[] {
  return events.filter((e): e is AgentEventOf<T> => e.type === type);
}

async function history(): Promise<AgentEvent[]> {
  const extras = await readTranscriptExtras(AGENTS_TRANSCRIPT);
  return buildHistory(agentsParallelMessages(), { toolResults: extras.toolResults }).events;
}

describe('история с субагентами (фикстура agents-parallel)', () => {
  it('агенты из вызовов Agent/Bash: id задачи и итоги из toolUseResult, фоновые — из уведомлений', async () => {
    const events = await history();
    const starts = ofType(events, 'agent.start');
    expect(starts.map((a) => [a.taskType, a.subagentType ?? '-', a.background])).toEqual([
      ['local_bash', '-', true],
      ['local_agent', 'Explore', false],
      ['local_agent', 'Explore', false],
      ['local_agent', 'general-purpose', true],
    ]);
    expect(starts.map((a) => a.taskId)).toEqual([
      'ba4jzv1up',
      'a8829ceaf8a64fefc',
      'af768b2aec0b6c731',
      'a8131aefac5b50945',
    ]);
    for (const a of starts) expect(a.at).toBeGreaterThan(0);
    const ends = ofType(events, 'agent.end');
    // два Explore — по результату вызова; general-purpose и Bash — по <task-notification>
    expect(ends.map((e) => [e.taskId, e.status])).toEqual([
      ['a8829ceaf8a64fefc', 'completed'],
      ['af768b2aec0b6c731', 'completed'],
      ['a8131aefac5b50945', 'completed'],
      ['ba4jzv1up', 'completed'],
    ]);
    expect(ends[0]?.summary).toContain('сброс состояния в onOpen');
    expect(ends[0]?.summary).not.toContain('Subagent hand-back');
    expect(ends[0]?.totalTokens).toBeGreaterThan(10_000);
    expect(ends[2]?.totalTokens).toBe(23735);
    expect(ends[2]?.summary).toContain('5 lines');
  });

  it('уведомление о задаче — ход-пробуждение без промпта, а не сообщение пользователя', async () => {
    const events = await history();
    const starts = ofType(events, 'turn.start');
    expect(starts.map((t) => t.prompt === undefined)).toEqual([false, true, true]);
    expect(starts.some((t) => t.prompt?.includes('<task-notification>'))).toBe(false);
    expect(ofType(events, 'turn.result')).toHaveLength(3);
    expect(buildHistory(agentsParallelMessages()).turns).toBe(1);
  });

  it('задача без конца: закрытая сессия — агент остановлен, идущая (live) — ещё идёт', async () => {
    const extras = await readTranscriptExtras(AGENTS_TRANSCRIPT);
    const msgs = agentsParallelMessages();
    // обрыв до уведомлений о фоновых задачах
    const cut = msgs.slice(
      0,
      msgs.findIndex(
        (m) => typeof (m.message as { content?: unknown })?.content === 'string' && m !== msgs[0],
      ),
    );
    const closed = buildHistory(cut, { toolResults: extras.toolResults }).events;
    expect(
      ofType(closed, 'agent.end')
        .slice(2)
        .map((e) => [e.taskId, e.status]),
    ).toEqual([
      ['ba4jzv1up', 'stopped'],
      ['a8131aefac5b50945', 'stopped'],
    ]);
    const live = buildHistory(cut, { toolResults: extras.toolResults, live: true }).events;
    expect(ofType(live, 'agent.end')).toHaveLength(2);
    // пересев webview живой сессии между ходами: ход закрыт, но процесс движка и задачи живы
    const alive = buildHistory(cut, { toolResults: extras.toolResults, tasksAlive: true }).events;
    expect(ofType(alive, 'agent.end')).toHaveLength(2);
    expect(ofType(alive, 'turn.result')).toHaveLength(1);
  });

  it('два уведомления в одной реплике — закрыты обе задачи', async () => {
    const note = (id: string) =>
      `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
    const events = buildHistory([
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'go' },
      },
      {
        type: 'user',
        uuid: 'u2',
        session_id: 's',
        parent_tool_use_id: null,
        message: { role: 'user', content: `${note('a')}\n${note('b')}` },
      },
    ] as never).events;
    expect(ofType(events, 'agent.end').map((e) => e.taskId)).toEqual(['a', 'b']);
  });

  it('ход субагента из subagents/: вызовы с agentId сразу после agent.start', async () => {
    const events = await history();
    await withSubagentTimelines(events, AGENTS_SUBAGENTS_DIR);
    for (const a of ofType(events, 'agent.start').filter((x) => x.taskType === 'local_agent')) {
      const i = events.indexOf(a);
      const own = events.filter((e) => e.agentId === a.agentId && e.type === 'tool.start');
      expect(own).toHaveLength(1);
      expect(events[i + 1]?.agentId).toBe(a.agentId);
      const result = events.find((e) => e.type === 'tool.result' && e.agentId === a.agentId);
      expect(
        result && 'durationMs' in result ? result.durationMs : undefined,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('транскрипт субагента', () => {
  it('файл по id задачи; чужой id в путь не попадает', async () => {
    expect(await subagentFile(AGENTS_SUBAGENTS_DIR, 'a8829ceaf8a64fefc')).toMatch(
      /agent-a8829ceaf8a64fefc\.jsonl$/,
    );
    expect(await subagentFile(AGENTS_SUBAGENTS_DIR, '../x')).toBeUndefined();
    expect(await subagentFile(AGENTS_SUBAGENTS_DIR, 'nope')).toBeUndefined();
  });

  it('Markdown: промпт, вызов, результат, итог; мета — тип и описание', async () => {
    const file = (await subagentFile(AGENTS_SUBAGENTS_DIR, 'a8829ceaf8a64fefc'))!;
    const meta = await readSubagentMeta(file);
    expect(meta).toEqual({
      agentType: 'Explore',
      description: 'Read second line from alpha/notes.md',
    });
    const md = subagentMarkdown(await readSubagentRecords(file), {
      title: meta.description!,
      agentType: meta.agentType!,
    });
    expect(md).toMatch(/^# Read second line from alpha\/notes\.md · Explore/);
    expect(md).toContain('## Промпт от основного');
    expect(md).toContain('**Read** `{"file_path":"/tmp/agentura-agents/alpha/notes.md"}`');
    expect(md).toContain('_результат:_');
    expect(md).toContain('сброс состояния в onOpen');
  });

  it('события: модель, вызов и результат с agentId', async () => {
    const file = (await subagentFile(AGENTS_SUBAGENTS_DIR, 'af768b2aec0b6c731'))!;
    const events = subagentEvents(await readSubagentRecords(file), 'A');
    expect(events.every((e) => e.agentId === 'A')).toBe(true);
    expect(ofType(events, 'usage.message')[0]?.model).toBe('claude-haiku-4-5-20251001');
    expect(ofType(events, 'tool.start').map((t) => t.name)).toEqual(['Read']);
    expect(ofType(events, 'tool.result')[0]?.isError).toBe(false);
  });
});

describe('разбор служебного текста', () => {
  it('handBackText снимает рамку и отступ', async () => {
    const text =
      '[Subagent hand-back] The text below… The report follows:\n  line 1\n    code\n  line 3';
    expect(handBackText(text)).toBe('line 1\n  code\nline 3');
    expect(handBackText('plain')).toBe('plain');
  });

  it('notificationEnd: статус, итог, токены; остановленная задача', async () => {
    const end = notificationEnd(
      '<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>killed</status>\n<summary>stopped</summary>\n</task-notification>',
      5,
    );
    expect(end).toEqual({
      type: 'agent.end',
      agentId: 'toolu_1',
      taskId: 't1',
      status: 'stopped',
      summary: 'stopped',
      at: 5,
    });
    expect(notificationEnd('<task-notification></task-notification>', 1)).toBeUndefined();
  });
});
