import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import { NEW_CHAT_PROMPT_LIMIT } from '../../shared/task';
import { newChatPopover, provider, tabChats, taskNewChat, taskState } from '../store';
import { ui } from '../strings';
import { issueKeyOf } from '../taskView';
import { send } from '../vscode';
import { Mark } from './TaskPane';

const ENGINES: readonly { id: AgentProvider; name: string }[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'cursor', name: 'Cursor' },
];

/**
 * Всплывашка «Новый чат по задаче» (roadmap 26, решение 13; `prototype/screens/new-task-chat.html`): о чём (станет первым сообщением),
 * агент, что передать, где работает. Открывается «＋ чат» полосы и «＋» внутренних вкладок (`newChatPopover`), выбор
 * не запоминается: каждое открытие — заново, движок по умолчанию — движок вкладки. Enter — создать, ⌥Enter — рядом,
 * Esc и клик мимо — закрыть.
 */
export function NewChatPopover() {
  const pos = newChatPopover.value;
  if (!pos) return null;
  const taskKey = tabChats.value?.taskKey ?? taskState.value?.taskKey;
  if (!taskKey) return null;
  return <Form pos={pos} taskKey={taskKey} />;
}

function Form({ pos, taskKey }: { pos: { left: number; top: number }; taskKey: string }) {
  const t = ui.task.ncp;
  const can = taskNewChat.value;
  const tabMode = !!tabChats.value;
  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState<AgentProvider>(provider.value);
  const [task, setTask] = useState(true);
  const [summary, setSummary] = useState(can.summary);
  const [changes, setChanges] = useState(false);
  const [where, setWhere] = useState<'same' | 'worktree'>('same');
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const key = issueKeyOf(taskKey);
  const close = () => (newChatPopover.value = undefined);
  const worktree = can.worktree && where === 'worktree';
  const summaryOn = can.summary && summary;

  function create(beside: boolean) {
    const text = prompt.trim();
    send({
      type: 'task.newChat',
      taskKey,
      provider: engine,
      ...(text ? { prompt: text } : {}),
      carry: { task, summary: summaryOn, changes },
      where: worktree ? 'worktree' : 'same',
      // при `tasks.tab = task` чат — внутренняя вкладка, «рядом» не бывает
      ...(beside && !tabMode ? { beside: true } : {}),
    });
    close();
  }

  useEffect(() => {
    input.current?.focus();
    const away = (e: Event) => {
      const el = e.target as Element | null;
      // кнопка, открывшая всплывашку, сама её переключает
      if (!root.current?.contains(el) && !el?.closest?.('.np, .tk-ctabs .plus')) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing || e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    create(e.altKey);
  }

  const title = taskState.value?.taskKey === taskKey ? taskState.value.card?.title : undefined;
  const top = `clamp(8px, ${pos.top}px, max(8px, 100vh - 700px))`;
  return (
    <div
      class="ncp"
      role="dialog"
      aria-label={t.aria}
      ref={root}
      style={{
        left: `clamp(8px, ${pos.left}px, max(8px, 100vw - 528px))`,
        top,
        maxHeight: `calc(100vh - ${top} - 8px)`,
      }}
    >
      <div class="ncp-head">
        <div class="ncp-heading">
          <h6>{t.title}</h6>
          <div class="ncp-context">
            <span class="k">{key}</span>
            {title && (
              <span class="task-title" title={title}>
                {title}
              </span>
            )}
          </div>
        </div>
        <button class="x" aria-label={t.close} data-tip={t.close} onClick={close}>
          ×
        </button>
      </div>
      <div class="ncp-body">
        <div class="lb">{t.agent}</div>
        <div class="seg engines" role="radiogroup" aria-label={t.agent}>
          {ENGINES.map((e) => (
            <button
              key={e.id}
              role="radio"
              aria-checked={engine === e.id}
              class={engine === e.id ? 'on' : ''}
              onClick={() => setEngine(e.id)}
            >
              <Mark provider={e.id} />
              {e.name}
            </button>
          ))}
        </div>
        <div class="ncp-prompt">
          <label class="lb" for="ncp-prompt">
            {t.promptLabel}
            <span class="optional">{t.optional}</span>
          </label>
          <textarea
            id="ncp-prompt"
            ref={input}
            class="inp"
            rows={3}
            maxLength={NEW_CHAT_PROMPT_LIMIT}
            placeholder={t.promptPh}
            value={prompt}
            aria-describedby="ncp-prompt-help"
            onInput={(e) => setPrompt((e.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
          />
          <div class="help" id="ncp-prompt-help">
            {t.promptHelp}
          </div>
        </div>
        <div class="lb section-label">{t.carry}</div>
        <div class="ncp-options">
          <label class="ck">
            <input
              type="checkbox"
              checked={task}
              onChange={(e) => setTask((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>
              {t.carryTask} <small>{t.carryTaskSmall}</small>
            </span>
          </label>
          <label class="ck" data-tip={can.summary ? undefined : t.carrySummaryOff}>
            <input
              type="checkbox"
              checked={summaryOn}
              disabled={!can.summary}
              onChange={(e) => setSummary((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>
              {t.carrySummary}{' '}
              <small>{can.summary ? t.carrySummarySmall : t.carrySummaryOff}</small>
            </span>
          </label>
          <label class="ck">
            <input
              type="checkbox"
              checked={changes}
              onChange={(e) => setChanges((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>
              {t.carryChanges} <small>{t.carryChangesSmall}</small>
            </span>
          </label>
        </div>
        <div class="lb section-label">{t.where}</div>
        <div class="seg locations" role="radiogroup" aria-label={t.where}>
          <button
            role="radio"
            aria-checked={!worktree}
            class={!worktree ? 'on' : ''}
            onClick={() => setWhere('same')}
          >
            <i class="radio" aria-hidden="true" />
            <span>
              <b>{t.whereSame}</b>
              <small>{t.whereSameSmall}</small>
            </span>
          </button>
          <button
            role="radio"
            aria-checked={worktree}
            class={worktree ? 'on' : ''}
            disabled={!can.worktree}
            data-tip={can.worktree ? undefined : t.treeOff}
            onClick={() => setWhere('worktree')}
          >
            <i class="radio" aria-hidden="true" />
            <span>
              <b>{t.whereTree}</b>
              <small>{can.worktree ? t.whereTreeSmall : t.treeOff}</small>
            </span>
          </button>
        </div>
        {worktree && <div class="note">{t.treeNote(key)}</div>}
      </div>
      <div class="ft">
        {!tabMode && (
          <button class="sec" data-tip={t.besideTitle} onClick={() => create(true)}>
            {t.beside}
            <span class="key" aria-hidden="true">
              ⌥ ↵
            </span>
          </button>
        )}
        <button class="go" onClick={() => create(false)}>
          {t.create}
          <span class="key" aria-hidden="true">
            ↵
          </span>
        </button>
      </div>
    </div>
  );
}
