import { signal, useSignalEffect } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  chat,
  chooseOption,
  currentSession,
  declineQuestion,
  hudState,
  interrupt,
  limitBlocked,
  newSession,
  recent,
  releaseLimit,
  replyTarget,
  openAgentTranscript,
  openImage,
  respondPermission,
  selectedAgent,
  showThinking,
  stopAgent,
  stopAgents,
  tick,
} from '../store';
import { activeCard, pendingPlan } from '../chatState';
import { limitBanner } from '../limitView';
import { cacheLive, turnBadge, turnsView } from '../hudView';
import { agentBadge, agentMapView, liveSubagents, waitingAgents } from '../agentsView';
import { ui } from '../strings';
import { send } from '../vscode';
import { Composer } from './Composer';
import { Empty } from './Empty';
import { Hud, type Tab } from './Hud';
import { Log } from './Log';
import { useStickToBottom } from '../useStickToBottom';
import { AgentsPane, TurnPane } from './SidePanes';
import type { FeedRow } from '../chatState';
import { formatDuration, toolView } from '../toolView';

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

  const s = chat.value;
  const working = s.status === 'working' || s.status === 'waiting';

  // секундный тик для таймеров ленты и кэша — пока идёт ход, есть живой агент или кэш не истёк
  const h = hudState.value;
  // блокировка лимитом тоже тикает: по сбросу поле ввода оживает само
  const blocked = limitBlocked.value;
  const ticking =
    working ||
    !!blocked ||
    h.agents.some((a) => a.status === 'running') ||
    cacheLive(h, tick.value);
  useEffect(() => {
    if (!ticking) return;
    tick.value = Date.now();
    const id = setInterval(() => (tick.value = Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  // Esc: отклонить ждущую карточку разрешения/вопроса, иначе остановить ход (поле ввода гасит Esc
  // сама, когда закрывает меню/историю/ответ карточке). Enter и цифры — карточке, только когда фокус
  // не в поле ввода и не на кнопке: печатающего человека карточка не перехватывает.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const card = activeCard(chat.value);
      if (e.key === 'Escape') {
        // идёт ответ карточке из поля ввода, а фокус ушёл из поля — Esc отменяет ответ, не карточку
        if (replyTarget.value) {
          replyTarget.value = undefined;
          return;
        }
        if (card?.kind === 'perm') respondPermission(card.toolUseId, 'deny');
        else if (card?.kind === 'question') declineQuestion(card.toolUseId);
        else if (chat.value.status === 'working') interrupt();
        return;
      }
      // с модификаторами — хоткеи VS Code (Cmd+1 — группа редактора), не карточке
      if (!card || typingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
        return;
      if (e.key === 'Enter' && card.kind === 'perm') {
        e.preventDefault();
        respondPermission(card.toolUseId, 'allow');
      } else if (card.kind === 'question' && /^[1-9]$/.test(e.key)) {
        const q = card.questions.find((x) => !card.picks[x.question]?.length) ?? card.questions[0];
        const opt = q?.options[Number(e.key) - 1];
        if (q && opt) {
          e.preventDefault();
          chooseOption(card.toolUseId, q.question, opt.label);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // автопрокрутка с «прилипанием»: если пользователь ушёл вверх — не дёргаем
  const { ref: paneRef, onScroll } = useStickToBottom<HTMLElement>([s.rows, tab.value]);

  const empty = s.rows.length === 0;
  // в пустой сессии вкладки «ход»/«агенты» отключены — после «new» возвращаемся в чат
  const t = empty ? 'chat' : tab.value;
  const now = tick.value;
  const last = s.rows[s.rows.length - 1];
  const live = working
    ? liveLabel(
        last,
        s.turnStartedAt,
        now,
        s.status === 'waiting',
        !!pendingPlan(s),
        !!h.compacting,
      )
    : undefined;
  const banner = blocked ? limitBanner(blocked, now) : undefined;
  const active = activeCard(s);

  const turnBdg = turnBadge(h);
  const agentsBdg = agentBadge(h);
  // основной ждёт своих субагентов: живая строка «ждёт N агентов» и «stop all»
  const awaited = working && s.status !== 'waiting' ? waitingAgents(s.rows, h) : [];
  const liveText = awaited.length
    ? `${ui.log.waitingAgents(awaited.length)}${s.turnStartedAt ? ` · ${formatDuration(now - s.turnStartedAt)}` : ''}`
    : live;
  // «карта агентов», «итог», «лог» в группе: выбрать агента и показать вкладку (в широкой она и так видна)
  const openAgent = (agentId: string) => {
    selectedAgent.value = agentId;
    if (!document.documentElement.hasAttribute('data-width')) tab.value = 'agents';
  };

  return (
    <div class="webview">
      <Hud
        project={s.project}
        title={s.title}
        tab={t}
        onTab={(k) => (tab.value = k)}
        sidePanesEnabled={!empty}
        badges={
          empty
            ? {}
            : { ...(turnBdg ? { turn: turnBdg } : {}), ...(agentsBdg ? { agents: agentsBdg } : {}) }
        }
        sessions={recent.value}
        currentId={currentSession.value ?? (s.sessionId || undefined)}
        onResume={(id) => send({ type: 'session.resume', sessionId: id })}
        onAllSessions={() => send({ type: 'sessions.show' })}
        onNew={newSession}
      />
      {banner && (
        <div class="banner" role="alert">
          <span class="p" aria-hidden="true">
            ■
          </span>
          <span>
            <b>{banner.title}</b> <span class="d">{banner.detail}</span>
          </span>
          <span class="acts">
            {banner.canRetry && (
              <button class="btn" title={ui.limit.retryTitle} onClick={releaseLimit}>
                {ui.limit.retry}
              </button>
            )}
            <button
              class="btn ghost"
              title={ui.limit.limitsTitle}
              onClick={() => send({ type: 'sessions.show' })}
            >
              {ui.limit.limits}
            </button>
          </span>
        </div>
      )}
      <div class="body">
        <main
          class="pane"
          id="pane-chat"
          aria-labelledby="tab-chat"
          hidden={t !== 'chat'}
          ref={paneRef}
          onScroll={onScroll}
        >
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
              mode={ui.modes[s.mode]?.[0] ?? s.mode}
              {...(active ? { activeId: active.id } : {})}
              onDiff={(toolUseId) => send({ type: 'diff.open', sessionId: s.sessionId, toolUseId })}
              onPreview={(path) => send({ type: 'preview.open', path })}
              onOpenUrl={(url) => send({ type: 'link.open', url })}
              onOpenImage={openImage}
              hud={h}
              onStopAgent={stopAgent}
              onOpenAgent={openAgent}
            >
              {liveText && (
                <div class="live" role="status">
                  <span
                    class="spin"
                    aria-hidden="true"
                    style={
                      s.status === 'waiting'
                        ? { borderTopColor: pendingPlan(s) ? 'var(--agent)' : 'var(--warn)' }
                        : undefined
                    }
                  />{' '}
                  {liveText}{' '}
                  {awaited.length ? (
                    // Esc по-прежнему останавливает ход целиком (interrupt), кнопка — только агентов
                    <button
                      class="stop"
                      title={ui.log.stopAllTitle}
                      onClick={() => stopAgents(liveSubagents(h).map((a) => a.taskId))}
                    >
                      {ui.log.stopAll}
                    </button>
                  ) : (
                    <button class="stop" onClick={interrupt}>
                      {/* пока ждёт ответа, Esc отклоняет карточку, а не останавливает ход */}
                      {s.status === 'waiting' ? ui.log.stopOnly : ui.log.stop}
                    </button>
                  )}
                </div>
              )}
            </Log>
          )}
        </main>
        <aside class="pane side" style={{ display: t === 'chat' ? 'none' : 'block' }}>
          <TurnPane turns={turnsView(h, now, s.cwd)} hidden={t !== 'turn'} />
          <AgentsPane
            view={agentMapView(h, {
              working,
              waiting: awaited.length > 0,
              now,
              cwd: s.cwd,
              hasSession: !!s.sessionId,
              ...(selectedAgent.value ? { selected: selectedAgent.value } : {}),
              ...(s.model ? { model: s.model } : {}),
            })}
            hidden={t !== 'agents'}
            onSelect={(id) => (selectedAgent.value = id)}
            onStop={stopAgent}
            onTranscript={openAgentTranscript}
          />
        </aside>
      </div>
      <Composer />
    </div>
  );
}

/** Фокус там, где печатают или жмут кнопку: Enter и цифры принадлежат им, а не карточке. */
function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A'].includes(t.tagName);
}

function liveLabel(
  last: FeedRow | undefined,
  startedAt: number | undefined,
  now: number,
  waiting: boolean,
  plan: boolean,
  compacting: boolean,
): string {
  let what: string = ui.log.answering;
  if (compacting) what = ui.log.compacting;
  else if (waiting) what = plan ? ui.log.waitingPlan : ui.log.waiting;
  else if (last?.kind === 'think' && last.endedAt === undefined) what = ui.log.thinking;
  else if (last?.kind === 'tool' && last.state === 'run')
    what = ui.log.running(toolView(last.name, last.input).op);
  const elapsed = startedAt ? ` · ${formatDuration(now - startedAt)}` : '';
  return `${what}${elapsed}`;
}
