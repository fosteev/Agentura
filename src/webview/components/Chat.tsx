import { signal, useSignalEffect } from '@preact/signals';
import { agents, compose, hud, log, turns } from '../fixtures/chat';
import { Hud, type Tab } from './Hud';
import { Log } from './Log';
import { AgentsPane, TurnPane } from './SidePanes';
import { ui } from '../strings';

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
      <Hud d={hud} tab={t} onTab={(k) => (tab.value = k)} />
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
        <div class="blocks" aria-hidden="true">
          {hud.blocks.map((c) => (
            <i class={c} />
          ))}
        </div>
        <div class="ctx">
          {compose.context.map((c) => (
            <span>
              <code>{c.name}</code>
              {c.range}
              <span class="x">✕</span>
            </span>
          ))}
          <span class="cn" title={ui.compose.ctxTitle}>
            {ui.compose.context} <b class="warn">{hud.ctxNow}</b> / {hud.ctxMax} ·{' '}
            <button>{ui.compose.compact}</button>
          </span>
        </div>
        <div class="prompt">
          <span class="p">$</span>
          <span class="text">{compose.placeholder}</span>
        </div>
        <div class="opts">
          <button class="mode">
            {ui.compose.mode} <b>{compose.mode}</b>
          </button>
          <button class="agent" title={ui.compose.agentTitle}>
            {ui.compose.agent} <b>{hud.agent}</b>
          </button>
          <button>
            {ui.compose.model} <b>{compose.model}</b>
          </button>
          <button>
            {ui.compose.effort} <b>{compose.effort}</b>
          </button>
          <span class="meters">
            <span class="m">
              <span class="clock" />
              {ui.compose.cache} <b>{hud.cache.time}</b> · <b>{hud.cache.hit}</b>
            </span>
            <span class="m" title={ui.compose.fiveHourTitle(hud.h5.reset)}>
              <span class="cells">
                {Array.from({ length: 10 }, (_, i) => (
                  <i class={i < hud.h5.cells ? 'on' : ''} />
                ))}
              </span>
              {ui.compose.fiveHour} <b>{hud.h5.percent}%</b>
            </span>
          </span>
          <button class="send" title={ui.compose.sendTitle}>
            {ui.compose.send}
          </button>
        </div>
      </footer>
    </div>
  );
}
