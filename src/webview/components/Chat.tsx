import { signal, useSignalEffect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
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
  openFile,
  respondPermission,
  selectedAgent,
  feedStyle,
  showThinking,
  stopAgent,
  stopAgents,
  tick,
} from '../store';
import { activeCard, pendingPlan } from '../chatState';
import { limitBanner } from '../limitView';
import { changesView } from '../changesView';
import { cacheLive } from '../hudView';
import { agentBadge, agentMapView, liveSubagents, waitingAgents } from '../agentsView';
import { ui } from '../strings';
import { readPanel, savePanel, send, type PanelState } from '../vscode';
import { Composer } from './Composer';
import { Empty } from './Empty';
import { Hud, type Tab } from './Hud';
import { TabBar, type TabItem } from './TabBar';
import { Log } from './Log';
import { useStickToBottom } from '../useStickToBottom';
import { AgentsPane, ChangesPane } from './SidePanes';
import type { FeedRow } from '../chatState';
import { formatDuration, toolView } from '../toolView';

const tab = signal<Tab>('chat');
/** Широкая вёрстка (ход и агенты панелью справа) включается с этой ширины вкладки. */
const WIDE_PX = 700;
/** Правая панель: ширина по умолчанию, минимум и сколько оставить ленте. */
const PANEL_DEF = 300;
const PANEL_MIN = 220;
const PANEL_RESERVE = 360;
const PANEL_STEP = 16;
/** Широкая ли вёрстка сейчас (панель справа вместо вкладок шапки). */
const wide = signal(typeof window !== 'undefined' && window.innerWidth >= WIDE_PX);

/** Ширина панели в пределах: от минимума до «ширина тела − резерв ленты» (тело не измерено — без верхнего предела). */
function clampPanel(w: number, bodyW: number): number {
  const max = bodyW > 0 ? Math.max(PANEL_MIN, bodyW - PANEL_RESERVE) : Infinity;
  return Math.round(Math.min(max, Math.max(PANEL_MIN, w)));
}

const ICON_HIDE = (
  <svg
    class="ico"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1"
    aria-hidden="true"
  >
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <path d="M10 2.5v11" stroke-dasharray="1.6 1.4" />
  </svg>
);
const ICON_SHOW = (
  <svg
    class="ico"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1"
    aria-hidden="true"
  >
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <path d="M10 2.5v11" />
    <path d="M10.5 3v10h3.5V3z" fill="currentColor" stroke="none" opacity=".55" />
  </svg>
);
const ICON_CHANGES = (
  <svg
    class="ico"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    aria-hidden="true"
  >
    <path d="M8 2v6M5 5h6M5 12h6" />
  </svg>
);
const ICON_AGENTS = (
  <svg
    class="ico"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    aria-hidden="true"
  >
    <circle cx="8" cy="3.5" r="1.8" />
    <circle cx="3.5" cy="12" r="1.8" />
    <circle cx="12.5" cy="12" r="1.8" />
    <path d="M7 5l-2.5 5.3M9 5l2.5 5.3" />
  </svg>
);

export function Chat() {
  // hud.css переключает вёрстку по html[data-width="900"]; в реальном webview ширину меряем сами
  useSignalEffect(() => {
    const apply = () => {
      const isWide = window.innerWidth >= WIDE_PX;
      wide.value = isWide;
      if (isWide) {
        document.documentElement.setAttribute('data-width', '900');
        tab.value = 'chat'; // вкладок шапки в широкой вёрстке нет
      } else document.documentElement.removeAttribute('data-width');
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  });

  // правая панель (широкая вёрстка): состояние своё у каждой вкладки чата, живёт в setState webview
  const [panel, setPanel] = useState<PanelState>(readPanel);
  const [bodyW, setBodyW] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // ref — чтобы быстрый повтор клавиши шёл от свежей ширины, а не от значения последнего рендера
  const panelRef = useRef(panel);
  const updatePanel = (patch: PanelState) => {
    panelRef.current = { ...panelRef.current, ...patch };
    setPanel(panelRef.current);
    savePanel(patch);
  };
  // ширина тела нужна для верхнего предела панели; меняется только с окном
  useEffect(() => {
    const measure = () => setBodyW(bodyRef.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const panelW = clampPanel(panel.w ?? PANEL_DEF, bodyW);
  const panelOff = !!panel.off;
  const dragWidth = (clientX: number) => {
    const r = bodyRef.current?.getBoundingClientRect();
    return r ? clampPanel(r.right - clientX, r.width) : PANEL_DEF;
  };
  const setLiveWidth = (w: number) => bodyRef.current?.style.setProperty('--side-w', `${w}px`);
  const stepWidth = (delta: number) => {
    const r = bodyRef.current?.getBoundingClientRect();
    const cur = clampPanel(panelRef.current.w ?? PANEL_DEF, r?.width ?? 0);
    updatePanel({ w: clampPanel(cur + delta, r?.width ?? 0) });
  };

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
  // в пустой сессии вкладки «изменения»/«агенты» отключены — после «new» возвращаемся в чат
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

  const changes = changesView(s.rows, { scope: panel.changes ?? 'session', now, cwd: s.cwd });
  const changesBdg = changes.badge;
  const agentsBdg = agentBadge(h);
  // основной ждёт своих субагентов: живая строка «ждёт N агентов» и «stop all»
  const awaited = working && s.status !== 'waiting' ? waitingAgents(s.rows, h) : [];
  const liveText = awaited.length
    ? `${ui.log.waitingAgents(awaited.length)}${s.turnStartedAt ? ` · ${formatDuration(now - s.turnStartedAt)}` : ''}`
    : live;
  // «карта агентов», «итог», «лог» в группе: выбрать агента и показать вкладку (в широкой она и так видна)
  const openAgent = (agentId: string) => {
    selectedAgent.value = agentId;
    if (wide.value) updatePanel({ tab: 'agents', off: false });
    else tab.value = 'agents';
  };
  // вкладки панели: в пустой сессии недоступны, активна «изменения»
  const panelTab = empty ? 'changes' : (panel.tab ?? 'changes');
  const panelItems: readonly TabItem<'changes' | 'agents'>[] = [
    {
      key: 'changes',
      label: ui.tabs.changes,
      disabled: empty,
      ...(changesBdg ? { badge: { text: String(changesBdg.count), live: changesBdg.live } } : {}),
    },
    {
      key: 'agents',
      label: ui.tabs.agents,
      disabled: empty,
      ...(agentsBdg ? { badge: agentsBdg } : {}),
    },
  ];

  return (
    <div class="webview" data-feed={feedStyle.value}>
      <Hud
        project={s.project}
        title={s.title}
        tab={t}
        onTab={(k) => (tab.value = k)}
        sidePanesEnabled={!empty}
        badges={
          empty
            ? {}
            : { ...(changesBdg ? { changes: changesBdg } : {}), ...(agentsBdg ? { agents: agentsBdg } : {}) }
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
              <button class="btn" data-tip={ui.limit.retryTitle} onClick={releaseLimit}>
                {ui.limit.retry}
              </button>
            )}
            <button
              class="btn ghost"
              data-tip={ui.limit.limitsTitle}
              onClick={() => send({ type: 'sessions.show' })}
            >
              {ui.limit.limits}
            </button>
          </span>
        </div>
      )}
      <div
        class="body"
        ref={bodyRef}
        data-side={wide.value && panelOff ? 'off' : undefined}
        style={{ '--side-w': `${panelW}px` }}
      >
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
              onOpenFile={openFile}
              hud={h}
              working={working}
              turnStartedAt={s.turnStartedAt}
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
                      data-tip={ui.log.stopAllTitle}
                      onClick={() => stopAgents(liveSubagents(h).map((a) => a.taskId))}
                    >
                      {ui.log.stopAll}
                    </button>
                  ) : (
                    <button
                      class="stop"
                      data-tip={ui.log.stopTip}
                      data-tip-key={s.status === 'waiting' ? undefined : 'Esc'}
                      onClick={interrupt}
                    >
                      {/* пока ждёт ответа, Esc отклоняет карточку, а не останавливает ход */}
                      {s.status === 'waiting' ? ui.log.stopOnly : ui.log.stop}
                    </button>
                  )}
                </div>
              )}
            </Log>
          )}
        </main>
        <aside
          class="pane side"
          data-active={panelTab}
          style={wide.value ? undefined : { display: t === 'chat' ? 'none' : 'block' }}
        >
          <TabBar
            class="ptabs"
            items={panelItems}
            active={panelTab}
            onSelect={(k) => updatePanel({ tab: k })}
            idPrefix="ptab"
            ariaLabel={ui.panel.tabsAria}
          >
            <button
              class="phide"
              data-tip={ui.panel.hide}
              aria-label={ui.panel.hide}
              onClick={() => updatePanel({ off: true })}
            >
              {ICON_HIDE}
            </button>
          </TabBar>
          <div
            class="grip"
            role="separator"
            aria-orientation="vertical"
            aria-label={ui.panel.gripAria}
            aria-valuenow={panelW}
            aria-valuemin={PANEL_MIN}
            aria-valuemax={bodyW > 0 ? clampPanel(Infinity, bodyW) : undefined}
            data-tip={ui.panel.gripTitle}
            tabIndex={0}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              dragging.current = true;
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              (e.currentTarget as HTMLElement).classList.add('drag');
              document.documentElement.classList.add('resizing');
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              if (dragging.current) setLiveWidth(dragWidth(e.clientX));
            }}
            onPointerUp={(e) => {
              if (!dragging.current) return;
              dragging.current = false;
              const grip = e.currentTarget as HTMLElement;
              grip.releasePointerCapture?.(e.pointerId);
              grip.classList.remove('drag');
              document.documentElement.classList.remove('resizing');
              updatePanel({ w: dragWidth(e.clientX) });
            }}
            onPointerCancel={(e) => {
              dragging.current = false;
              (e.currentTarget as HTMLElement).classList.remove('drag');
              document.documentElement.classList.remove('resizing');
              setLiveWidth(panelW);
            }}
            onLostPointerCapture={(e) => {
              // захват сорвался без pointerup (ручку скрыли, окно отобрало мышь) — не оставлять
              // ручку «залипшей», а html — без выделения текста; ширину берём последнюю показанную
              if (!dragging.current) return;
              dragging.current = false;
              (e.currentTarget as HTMLElement).classList.remove('drag');
              document.documentElement.classList.remove('resizing');
              const live = parseFloat(bodyRef.current?.style.getPropertyValue('--side-w') ?? '');
              updatePanel({ w: Number.isFinite(live) ? live : panelW });
            }}
            onDblClick={() => updatePanel({ w: PANEL_DEF })}
            onKeyDown={(e) => {
              // панель справа: ← двигает левый край влево (шире), → — вправо (уже)
              if (e.key === 'ArrowLeft') stepWidth(PANEL_STEP);
              else if (e.key === 'ArrowRight') stepWidth(-PANEL_STEP);
              else if (e.key === 'Home') updatePanel({ w: PANEL_DEF });
              else return;
              e.preventDefault();
            }}
          />
          <ChangesPane
            view={changes}
            hidden={wide.value ? panelTab !== 'changes' : t !== 'changes'}
            labelledBy={wide.value ? 'ptab-changes' : 'tab-changes'}
            onScope={(scope) => updatePanel({ changes: scope })}
            onDiff={(toolUseIds) =>
              send({ type: 'diff.changes', sessionId: s.sessionId, toolUseIds })
            }
          />
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
            hidden={wide.value ? panelTab !== 'agents' : t !== 'agents'}
            labelledBy={wide.value ? 'ptab-agents' : 'tab-agents'}
            onSelect={(id) => (selectedAgent.value = id)}
            onStop={stopAgent}
            onTranscript={openAgentTranscript}
          />
        </aside>
        <nav class="rail" aria-label={ui.panel.railAria}>
          <button
            data-tip={ui.tabs.changes}
            aria-label={ui.panel.openTab(ui.tabs.changes)}
            disabled={empty}
            onClick={() => updatePanel({ tab: 'changes', off: false })}
          >
            {ICON_CHANGES}
            {changesBdg && (
              <span class={changesBdg.live ? 'b live' : 'b'}>{changesBdg.count}</span>
            )}
          </button>
          <button
            data-tip={ui.tabs.agents}
            aria-label={ui.panel.openTab(ui.tabs.agents)}
            disabled={empty}
            onClick={() => updatePanel({ tab: 'agents', off: false })}
          >
            {ICON_AGENTS}
            {agentsBdg && (
              <span class={agentsBdg.live ? 'b live' : 'b'}>{agentsBdg.text.split(' / ')[0]}</span>
            )}
          </button>
          <button
            class="show"
            data-tip={ui.panel.show}
            aria-label={ui.panel.show}
            onClick={() => updatePanel({ off: false })}
          >
            {ICON_SHOW}
          </button>
        </nav>
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
