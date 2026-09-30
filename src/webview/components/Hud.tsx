import { ui } from '../strings';

export type Tab = 'chat' | 'turn' | 'agents';

export function Hud({
  project,
  title,
  tab,
  onTab,
  sidePanesEnabled,
  onSessions,
  onNew,
}: {
  project: string;
  title?: string;
  tab: Tab;
  onTab: (t: Tab) => void;
  /** Панели «ход» и «агенты» недоступны в пустой сессии (экран empty). */
  sidePanesEnabled: boolean;
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
