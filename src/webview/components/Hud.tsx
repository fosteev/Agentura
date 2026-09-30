import { ui } from '../strings';

export type Tab = 'chat' | 'turn' | 'agents';

export function Hud({
  project,
  title,
  tab,
  onTab,
  sidePanesEnabled,
  badges,
  onSessions,
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
  onSessions: () => void;
  onNew: () => void;
}) {
  const tabs: readonly (readonly [Tab, string])[] = [
    ['chat', ui.tabs.chat],
    ['turn', ui.tabs.turn],
    ['agents', ui.tabs.agents],
  ];
  return (
    <header class="hud" aria-label={ui.hud.aria}>
      <nav class="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button
            role="tab"
            aria-selected={tab === k}
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
      <span class="acts">
        <button title={ui.hud.sessionsTitle} onClick={onSessions}>
          {ui.hud.sessions}
        </button>
        <button title={ui.hud.newChatTitle} onClick={onNew}>
          {ui.hud.newChat}
        </button>
      </span>
    </header>
  );
}
