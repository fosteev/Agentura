import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionSummary } from '../../protocol';
import { menuKeys } from '../a11y';
import { costLabel, foreignProvider, mixedProviders, providerName, tokensLabel, whenLabel } from '../sessionsView';
import { ui } from '../strings';
import { TabBar, type TabItem } from './TabBar';

export type Tab = 'chat' | 'changes' | 'git' | 'agents' | 'task';

export function Hud({
  project,
  title,
  tab,
  onTab,
  sidePanesEnabled,
  agentsTab = true,
  taskTab = false,
  badges,
  sessions,
  currentId,
  onResume,
  onAllSessions,
  onNew,
  remote,
  onRemote,
}: {
  project: string;
  title?: string;
  tab: Tab;
  onTab: (t: Tab) => void;
  /** Панели «изменения» и «агенты» недоступны в пустой сессии (экран empty). */
  sidePanesEnabled: boolean;
  /** Вкладка «агенты» есть только у движка с субагентами (`features.subagents`). */
  agentsTab?: boolean;
  /** Вкладка «задача» есть у чата по задаче (`tasks.card` ≠ `strip`; при `split` — только если источник не Jiraffe). */
  taskTab?: boolean;
  /** Бейджи вкладок: число файлов сессии (`live` — идёт правка) и агенты хода `идут / всего` (A6). */
  badges: {
    changes?: { count: number; live: boolean };
    git?: { count: number };
    agents?: { text: string; live: boolean };
    /** Событий задачи, которых человек ещё не видел. */
    task?: number;
  };
  /** Сессии проекта, коротко (`sessions.update`) — попап `sessions`. */
  sessions: SessionSummary[];
  currentId?: string | undefined;
  onResume: (id: string) => void;
  onAllSessions: () => void;
  onNew: () => void;
  /** Remote Control включён (`remote.state` = on): метка «● remote», её title — ссылка. */
  remote?: { url?: string | undefined } | undefined;
  onRemote?: ((url: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLSpanElement>(null);
  // закрыть попап кликом мимо и по Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const now = Date.now();
  const mixed = mixedProviders(sessions);
  const allTabs: readonly TabItem<Tab>[] = [
    { key: 'chat', label: ui.tabs.chat },
    {
      key: 'changes',
      label: ui.tabs.changes,
      disabled: !sidePanesEnabled,
      ...(badges.changes
        ? { badge: { text: String(badges.changes.count), live: badges.changes.live } }
        : {}),
    },
    {
      key: 'git',
      label: ui.tabs.git,
      disabled: !sidePanesEnabled,
      ...(badges.git ? { badge: { text: String(badges.git.count), live: false } } : {}),
    },
    {
      key: 'agents',
      label: ui.tabs.agents,
      disabled: !sidePanesEnabled,
      ...(badges.agents ? { badge: badges.agents } : {}),
    },
  ];
  const taskItem: TabItem<Tab> = {
    key: 'task',
    label: ui.tabs.task,
    ...(badges.task ? { badge: { text: String(badges.task), live: true } } : {}),
  };
  const tabs = [...(agentsTab ? allTabs : allTabs.filter((i) => i.key !== 'agents')), ...(taskTab ? [taskItem] : [])];
  return (
    <header class="hud" aria-label={ui.hud.aria}>
      <TabBar
        class="tabs"
        tag="nav"
        items={tabs}
        active={tab}
        onSelect={onTab}
        idPrefix="tab"
        ariaLabel={ui.hud.aria}
      />
      <span class="sess">
        {project} · <b>{title || ui.hud.untitled}</b>
      </span>
      <span class="acts" ref={pop} onKeyDown={menuKeys}>
        {remote && (
          <button
            class="rcb"
            data-tip={remote.url ?? ui.remote.badgeTitle}
            onClick={() => remote.url && onRemote?.(remote.url)}
          >
            {ui.remote.badge}
          </button>
        )}
        <button
          data-tip={ui.hud.sessionsTitle}
          style={open ? { color: 'var(--fg)' } : undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {ui.hud.sessions}
        </button>
        {open && (
          <div class="menu down" role="menu">
            <div class="hd">{ui.sessionsPopup.heading(project)}</div>
            {sessions.length === 0 && <div class="hd">{ui.sessionsPopup.empty}</div>}
            {sessions.map((s) => (
              <button
                class={s.id === currentId ? 'it sel' : 'it'}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  if (s.id !== currentId) onResume(s.id);
                }}
              >
                <span>
                  {s.title}
                  <small>
                    {[
                      whenLabel(s, now),
                      mixed || foreignProvider(s) ? providerName(s) : '',
                      // у Codex-треда ходов и стоимости нет
                      foreignProvider(s) ? '' : ui.empty.turns(s.turns),
                      foreignProvider(s) ? '' : costLabel(s),
                      s.state === 'waiting' ? ui.sidebar.stateTag.waiting : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
                <span class="hint">{s.contextTokens ? tokensLabel(s.contextTokens) : ''}</span>
              </button>
            ))}
            <div class="sep" />
            <button
              class="it"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAllSessions();
              }}
            >
              <span>{ui.sessionsPopup.all}</span>
              <span class="hint">☰</span>
            </button>
            <button
              class="it"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNew();
              }}
            >
              <span>{ui.sessionsPopup.newSession}</span>
              <span class="hint">{ui.sidebar.newSessionKey}</span>
            </button>
          </div>
        )}
      </span>
    </header>
  );
}
