import { signal, useSignalEffect } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import {
  chat,
  hudState,
  interrupt,
  newSession,
  recent,
  showThinking,
  stopAgent,
  tick,
} from '../store';
import { agentRows, cacheLive, sessionTotals, turnBadge, turnsView } from '../hudView';
import { ui } from '../strings';
import { send } from '../vscode';
import { Composer } from './Composer';
import { Empty } from './Empty';
import { Hud, type Tab } from './Hud';
import { Log } from './Log';
import { AgentsPane, TurnPane } from './SidePanes';
import type { FeedRow } from '../chatState';
import { formatDuration, toolView } from '../toolView';

const tab = signal<Tab>('chat');
/** Широкая вёрстка (ход и агенты панелью справа) включается с этой ширины вкладки. */
const WIDE_PX = 700;
/** Насколько близко к низу лента считается «прилипшей». */
const STICK_PX = 32;

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

  const s = chat.value;
  const working = s.status === 'working' || s.status === 'waiting';

  // секундный тик для таймеров ленты и кэша — пока идёт ход, есть живой агент или кэш не истёк
  const h = hudState.value;
  const ticking =
    working || h.agents.some((a) => a.status === 'running') || cacheLive(h, tick.value);
  useEffect(() => {
    if (!ticking) return;
    tick.value = Date.now();
    const id = setInterval(() => (tick.value = Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  // Esc останавливает ход (поле ввода гасит Esc сама, когда закрывает меню/историю)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && chat.value.status === 'working') interrupt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // автопрокрутка с «прилипанием»: если пользователь ушёл вверх — не дёргаем
  const paneRef = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = paneRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.rows, tab.value]);

  const empty = s.rows.length === 0;
  // в пустой сессии вкладки «ход»/«агенты» отключены — после «new» возвращаемся в чат
  const t = empty ? 'chat' : tab.value;
  const now = tick.value;
  const last = s.rows[s.rows.length - 1];
  const live = working ? liveLabel(last, s.turnStartedAt, now) : undefined;

  const turnBdg = turnBadge(h);

  return (
    <div class="webview">
      <Hud
        project={s.project}
        title={s.title}
        tab={t}
        onTab={(k) => (tab.value = k)}
        sidePanesEnabled={!empty}
        badges={empty ? {} : { ...(turnBdg ? { turn: turnBdg } : {}), agents: 1 + h.agents.length }}
        onSessions={() => send({ type: 'sessions.show' })}
        onNew={newSession}
      />
      <div class="body">
        <main class="pane" id="pane-chat" hidden={t !== 'chat'} ref={paneRef} onScroll={onScroll}>
          {empty ? (
            <Empty
              project={s.project}
              recent={recent.value}
              onResume={(id) => send({ type: 'session.resume', sessionId: id })}
            />
          ) : (
            <Log
              rows={s.rows}
              cwd={s.cwd}
              now={now}
              showThinking={showThinking.value}
              onDiff={(toolUseId) => send({ type: 'diff.open', sessionId: s.sessionId, toolUseId })}
            >
              {live && (
                <div class="live">
                  <span class="spin" /> {live}{' '}
                  <button class="stop" onClick={interrupt}>
                    {ui.log.stop}
                  </button>
                </div>
              )}
            </Log>
          )}
        </main>
        <aside class="pane side" style={{ display: t === 'chat' ? 'none' : 'block' }}>
          <TurnPane turns={turnsView(h, now, s.cwd)} hidden={t !== 'turn'} />
          <AgentsPane
            rows={agentRows(h, { working, now, ...(s.model ? { model: s.model } : {}) })}
            totals={sessionTotals(h)}
            hidden={t !== 'agents'}
            onStop={stopAgent}
          />
        </aside>
      </div>
      <Composer />
    </div>
  );
}

function liveLabel(last: FeedRow | undefined, startedAt: number | undefined, now: number): string {
  let what: string = ui.log.answering;
  if (last?.kind === 'think' && last.endedAt === undefined) what = ui.log.thinking;
  else if (last?.kind === 'tool' && last.state === 'run')
    what = ui.log.running(toolView(last.name, last.input).op);
  const elapsed = startedAt ? ` · ${formatDuration(now - startedAt)}` : '';
  return `${what}${elapsed}`;
}
