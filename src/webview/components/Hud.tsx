import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionSummary } from '../../protocol';
import { menuKeys, tabStep } from '../a11y';
import { costLabel, tokensLabel, whenLabel } from '../sessionsView';
import { ui } from '../strings';

export type Tab = 'chat' | 'turn' | 'agents';

export function Hud({
  project,
  title,
  tab,
  onTab,
  sidePanesEnabled,
  badges,
  sessions,
  currentId,
  onResume,
  onAllSessions,
  onNew,
}: {
  project: string;
  title?: string;
  tab: Tab;
  onTab: (t: Tab) => void;
  /** Панели «ход» и «агенты» недоступны в пустой сессии (экран empty). */
  sidePanesEnabled: boolean;
  /** Бейджи вкладок: число строк хода (`live` — ход идёт) и число агентов. */
  badges: { turn?: { count: number; live: boolean }; agents?: number };
  /** Сессии проекта, коротко (`sessions.update`) — попап `sessions`. */
  sessions: SessionSummary[];
  currentId?: string | undefined;
  onResume: (id: string) => void;
  onAllSessions: () => void;
  onNew: () => void;
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
  const tabs: readonly (readonly [Tab, string])[] = [
    ['chat', ui.tabs.chat],
    ['turn', ui.tabs.turn],
    ['agents', ui.tabs.agents],
  ];
  return (
    <header class="hud" aria-label={ui.hud.aria}>
      <nav
        class="tabs"
        role="tablist"
        aria-label={ui.hud.aria}
        onKeyDown={(e) => {
          const enabled = tabs.map(([k]) => k === 'chat' || sidePanesEnabled);
          const next = tabStep(
            e.key,
            tabs.findIndex(([k]) => k === tab),
            enabled,
          );
          if (next === undefined) return;
          e.preventDefault();
          onTab(tabs[next]![0]);
          const list = e.currentTarget as HTMLElement | null;
          requestAnimationFrame(() => {
            const buttons = list?.querySelectorAll<HTMLElement>('[role=tab]');
            buttons?.[next]?.focus();
          });
        }}
      >
        {tabs.map(([k, label]) => (
          <button
            role="tab"
            id={`tab-${k}`}
            aria-controls={`pane-${k}`}
            aria-selected={tab === k}
            tabIndex={tab === k ? 0 : -1}
            disabled={k !== 'chat' && !sidePanesEnabled}
            onClick={() => onTab(k)}
          >
            {label}
            {k === 'turn' && badges.turn && (
              <span class={badges.turn.live ? 'b live' : 'b'}>{badges.turn.count}</span>
            )}
            {k === 'agents' && badges.agents !== undefined && (
              <span class="b">{badges.agents}</span>
            )}
          </button>
        ))}
      </nav>
      <span class="sess">
        {project} · <b>{title || ui.hud.untitled}</b>
      </span>
      <span class="acts" ref={pop} onKeyDown={menuKeys}>
        <button
          title={ui.hud.sessionsTitle}
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
                      ui.empty.turns(s.turns),
                      costLabel(s),
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
