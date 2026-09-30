import { signal, useSignalEffect } from '@preact/signals';
import { agents, compose, hud, log, turns } from '../fixtures/chat';
import { Hud } from './Hud';
import { Log } from './Log';
import { AgentsPane, TurnPane } from './SidePanes';
import { ui } from '../strings';

type Tab = 'chat' | 'turn' | 'agents';
const tab = signal<Tab>('chat');
/** Широкая вёрстка (ход и агенты панелью справа) включается с этой ширины вкладки. */
const WIDE_PX = 700;

export function Chat() {
  // hud.css переключает вёрстку по html[data-width="900"]; в реальном webview ширину меряем сами
  useSignalEffect(() => {
    const apply = () => {
      const wide = window.innerWidth >= WIDE_PX;
      if (wide) {
        document.documentElement.setAttribute('data-width', '900');
        tab.value = 'chat'; // вкладок в широкой вёрстке нет
      } else document.documentElement.removeAttribute('data-width');
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  });

  const t = tab.value;
  return (
    <div class="webview">
      <Hud d={hud} />
      <nav class="tabs" role="tablist">
        {(
          [
            ['chat', ui.tabs.chat, null],
            ['turn', ui.tabs.turn, <span class="b live">2</span>],
            ['agents', ui.tabs.agents, <span class="b">3</span>],
          ] as const
        ).map(([k, label, badge]) => (
          <button
            role="tab"
            aria-selected={t === k}
            onClick={() => {
              tab.value = k;
            }}
          >
            {label}
            {badge && ' '}
            {badge}
          </button>
        ))}
      </nav>
      <div class="body">
        <main class="pane" id="pane-chat" hidden={t !== 'chat'}>
          <Log items={log} />
        </main>
        <aside class="pane side" style={{ display: t === 'chat' ? 'none' : 'block' }}>
          <TurnPane turns={turns} hidden={t !== 'turn'} />
          <AgentsPane rows={agents.rows} totals={agents.totals} hidden={t !== 'agents'} />
        </aside>
      </div>
      <footer class="compose">
        <div class="ctx">
          {compose.context.map((c) => (
            <span>
              <code>{c.name}</code>
              {c.range}
              <span class="x">✕</span>
            </span>
          ))}
        </div>
        <div class="prompt">
          <span class="p">$</span>
          <span class="text">{compose.placeholder}</span>
        </div>
        <div class="opts">
          <button class="mode">
            {ui.compose.mode} <b>{compose.mode}</b>
          </button>
          <button>
            {ui.compose.model} <b>{compose.model}</b>
          </button>
          <button>
            {ui.compose.effort} <b>{compose.effort}</b>
          </button>
          <button class="send" title={ui.compose.sendTitle}>
            {ui.compose.send}
          </button>
        </div>
      </footer>
    </div>
  );
}
