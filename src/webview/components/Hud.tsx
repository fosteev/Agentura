import type { Hud as HudData } from '../fixtures/chat';
import { ui } from '../strings';

export type Tab = 'chat' | 'turn' | 'agents';

const TABS: readonly (readonly [Tab, string, preact.ComponentChildren])[] = [
  ['chat', ui.tabs.chat, null],
  ['turn', ui.tabs.turn, <span class="b live">2</span>],
  ['agents', ui.tabs.agents, <span class="b">3</span>],
];

export function Hud({
  d,
  tab,
  onTab,
  menu,
}: {
  d: HudData;
  tab: Tab;
  onTab: (t: Tab) => void;
  menu?: preact.ComponentChildren;
}) {
  return (
    <header class="hud" aria-label={ui.hud.aria}>
      <nav class="tabs" role="tablist">
        {TABS.map(([k, label, badge]) => (
          <button role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>
            {label}
            {badge && ' '}
            {badge}
          </button>
        ))}
      </nav>
      <span class="sess">
        {d.project} · <b>{d.title}</b>
      </span>
      <span class={menu ? 'acts pop' : 'acts'}>
        <button title={ui.hud.sessionsTitle}>{ui.hud.sessions}</button>
        <button title={ui.hud.newChatTitle}>{ui.hud.newChat}</button>
        {menu}
      </span>
    </header>
  );
}
