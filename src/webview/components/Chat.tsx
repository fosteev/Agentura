import { uiZoom } from '../appearance';
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
  features,
  feedStyle,
  gitSnapshot,
  agentsView,
  gitLayout,
  showThinking,
  stopAgent,
  stopAgents,
  taskCardMode,
  taskChats,
  tabChats,
  activeTabChat,
  taskState,
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
import { AgentsPane, ChangesPane, type AgentsPaneModel } from './SidePanes';
import { GitPane } from './GitPane';
import { ChatTabs, TaskPane, TaskStrip } from './TaskPane';
import { isTaskChat, latestSeen, taskDefaultView, taskPanelShown, unseenCount, visibleEvents } from '../taskView';
import { agentPathSet, gitBadge } from '../gitView';
import { agentsViewPane, defaultScope } from '../agentViews';
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

/** Клик по сессии в попапе или на экране empty: движок — из строки списка (нет поля — Claude). */
function resumeSession(id: string): void {
  const provider = recent.value.find((r) => r.id === id)?.provider;
  send({ type: 'session.resume', sessionId: id, ...(provider ? { provider } : {}) });
}

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
const ICON_GIT = (
  <svg
    class="ico"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    aria-hidden="true"
  >
    <circle cx="4.5" cy="3.5" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="5.5" r="1.6" />
    <path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3-7 3.8" />
  </svg>
);
const ICON_TASK = (
  <svg
    class="ico"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    aria-hidden="true"
  >
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
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
      const isWide = window.innerWidth / uiZoom() >= WIDE_PX;
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
    // ширины ниже — в пикселях окна; панель задаётся в px вёрстки, их масштаб `zoom` умножит (uiZoom)
    const measure = () =>
      setBodyW((bodyRef.current?.getBoundingClientRect().width ?? 0) / uiZoom());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const panelW = clampPanel(panel.w ?? PANEL_DEF, bodyW);
  const panelOff = !!panel.off;
  const dragWidth = (clientX: number) => {
    const r = bodyRef.current?.getBoundingClientRect();
    const z = uiZoom();
    return r ? clampPanel((r.right - clientX) / z, r.width / z) : PANEL_DEF;
  };
  const setLiveWidth = (w: number) => bodyRef.current?.style.setProperty('--side-w', `${w}px`);
  const stepWidth = (delta: number) => {
    const r = bodyRef.current?.getBoundingClientRect();
    const bw = (r?.width ?? 0) / uiZoom();
    const cur = clampPanel(panelRef.current.w ?? PANEL_DEF, bw);
    updatePanel({ w: clampPanel(cur + delta, bw) });
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
  // вкладка «агенты» есть не у каждого движка (`features.subagents`): сохранённая или открытая — уступает «изменениям»
  const subagents = features.value.subagents;
  // вкладка «задача» (чат по задаче, roadmap 19): доступна и в пустой сессии — карточку видно до первого сообщения
  const ts = taskState.value;
  const taskOn = taskPanelShown(taskCardMode.value, ts);
  const taskSeg = panel.taskView ?? taskDefaultView(taskCardMode.value, ts);
  const t: Tab =
    tab.value === 'task'
      ? taskOn
        ? 'task'
        : 'chat'
      : empty
        ? 'chat'
        : !subagents && tab.value === 'agents'
          ? 'changes'
          : tab.value;
  const now = tick.value;
  // что человек уже видел в ленте задачи: пока данных не было, «нового» нет; первая загрузка считается просмотренной
  const taskKey = ts?.taskKey;
  const seen =
    taskKey && panel.taskSeenKey === taskKey && panel.taskSeen !== undefined
      ? panel.taskSeen
      : Number.POSITIVE_INFINITY;
  const [humanDone, setHumanDone] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!ts || !taskKey || ts.fetchedAt === 0) return;
    if (panel.taskSeenKey === taskKey && panel.taskSeen !== undefined) return;
    updatePanel({ taskSeen: latestSeen(ts), taskSeenKey: taskKey });
  }, [taskKey, ts?.fetchedAt]);
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
  // вкладка «git»: метка агента — файл есть среди правок ленты за всю сессию (охват вкладки «изменения» не важен)
  const sessionChanges =
    changes.scope === 'session'
      ? changes
      : changesView(s.rows, { scope: 'session', now, cwd: s.cwd });
  const agentPaths = agentPathSet(sessionChanges.dirs);
  const gitSnap = gitSnapshot.value;
  const gitBdg = gitBadge(gitSnap);
  const agentsBdg = agentBadge(h);
  // основной ждёт своих субагентов: живая строка «ждёт N агентов» и «stop all»
  const awaited = working && s.status !== 'waiting' ? waitingAgents(s.rows, h) : [];
  // вид вкладки «агенты»: `graph` в панели показывает список (граф — вкладка редактора, этап 2 roadmap 11)
  const agentsMode = agentsView.value === 'graph' ? 'list' : agentsView.value;
  const agentsOpts = {
    working,
    waiting: awaited.length > 0,
    now,
    cwd: s.cwd,
    hasSession: !!s.sessionId,
    ...(selectedAgent.value ? { selected: selectedAgent.value } : {}),
    ...(s.model ? { model: s.model } : {}),
  };
  // виды Б/В/Г считаются только на видимой вкладке (раз в секунду, на всю сессию — не бесплатно)
  const agentsModel = (hidden: boolean): AgentsPaneModel =>
    agentsMode === 'list'
      ? { mode: 'list', view: agentMapView(h, agentsOpts) }
      : hidden
        ? { mode: 'hidden' }
        : {
            mode: 'views',
            view: agentsViewPane(
              h,
              agentsMode,
              panel.agScope?.[agentsMode] ?? defaultScope(agentsMode),
              agentsOpts,
            ),
          };
  const liveText = awaited.length
    ? `${ui.log.waitingAgents(awaited.length)}${s.turnStartedAt ? ` · ${formatDuration(now - s.turnStartedAt)}` : ''}`
    : live;
  // граф агентов во вкладке редактора (roadmap 11, этап 2): хост открывает или показывает вкладку графа этого чата
  const openGraph = (agentId?: string) =>
    send({ type: 'agents.openGraph', ...(agentId ? { agentId } : {}) });
  // «карта агентов», «итог», «лог» в группе: выбрать агента и показать вкладку (в широкой она и так видна);
  // при виде `graph` — открыть граф с этим агентом
  const openAgent = (agentId: string) => {
    selectedAgent.value = agentId;
    if (agentsView.value === 'graph') openGraph(agentId);
    else if (wide.value) updatePanel({ tab: 'agents', off: false });
    else tab.value = 'agents';
  };
  // вкладки панели: в пустой сессии недоступны, активна «изменения»
  const panelTab: NonNullable<PanelState['tab']> =
    panel.tab === 'task'
      ? taskOn
        ? 'task'
        : 'changes'
      : empty
        ? 'changes'
        : !subagents && panel.tab === 'agents'
          ? 'changes'
          : (panel.tab ?? 'changes');
  // вкладка «задача» видна (широкая — активна в несвёрнутой панели, узкая — открыта в шапке); открыта лента — бейджа нет:
  // отметка «видел» сдвигается эффектом `TaskPane` после кадра, бейдж не должен мелькнуть на этот кадр
  const taskShown = taskOn && (wide.value ? panelTab === 'task' && !panelOff : t === 'task');
  const taskBdg = taskOn && !(taskShown && taskSeg === 'changes') ? unseenCount(visibleEvents(ts), seen) : 0;
  // относительные времена вкладки («обновлено …», «N мин назад») идут и в простое, когда общий тик стоит
  useEffect(() => {
    if (!taskShown) return;
    tick.value = Date.now();
    const id = setInterval(() => (tick.value = Date.now()), 15_000);
    return () => clearInterval(id);
  }, [taskShown]);
  const panelAll: readonly TabItem<'changes' | 'git' | 'agents' | 'task'>[] = [
    {
      key: 'changes',
      label: ui.tabs.changes,
      disabled: empty,
      ...(changesBdg ? { badge: { text: String(changesBdg.count), live: changesBdg.live } } : {}),
    },
    {
      key: 'git',
      label: ui.tabs.git,
      disabled: empty,
      ...(gitBdg ? { badge: { text: String(gitBdg.count), live: false } } : {}),
    },
    {
      key: 'agents',
      label: ui.tabs.agents,
      disabled: empty,
      ...(agentsBdg ? { badge: agentsBdg } : {}),
    },
    {
      key: 'task',
      label: ui.tabs.task,
      ...(taskBdg ? { badge: { text: String(taskBdg), live: true } } : {}),
    },
  ];
  const panelItems = panelAll.filter(
    (i) => (i.key !== 'agents' || subagents) && (i.key !== 'task' || taskOn),
  );

  // вкладка «git» видна: широкая — активна и панель не свёрнута, узкая — открыта вкладка шапки
  const gitShown = wide.value ? panelTab === 'git' && !panelOff : t === 'git';
  useGitWatch(gitShown);

  return (
    <div
      class="webview"
      data-feed={feedStyle.value}
      data-agents={agentsView.value}
      data-git={gitLayout.value}
    >
      <Hud
        project={s.project}
        title={s.title}
        tab={t}
        onTab={(k) => (tab.value = k)}
        sidePanesEnabled={!empty}
        agentsTab={subagents}
        taskTab={taskOn}
        badges={
          empty
            ? taskBdg
              ? { task: taskBdg }
              : {}
            : {
                ...(changesBdg ? { changes: changesBdg } : {}),
                ...(gitBdg ? { git: gitBdg } : {}),
                ...(agentsBdg ? { agents: agentsBdg } : {}),
                ...(taskBdg ? { task: taskBdg } : {}),
              }
        }
        sessions={recent.value}
        currentId={currentSession.value ?? (s.sessionId || undefined)}
        onResume={resumeSession}
        onAllSessions={() => send({ type: 'sessions.show' })}
        onNew={newSession}
        remote={s.remote?.state === 'on' ? { url: s.remote.url } : undefined}
        onRemote={(url) => send({ type: 'link.open', url })}
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
      {isTaskChat(ts) && <TaskStrip state={ts} />}
      {tabChats.value && <ChatTabs state={tabChats.value} />}
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
              onResume={resumeSession}
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
          <GitPane
            snapshot={gitSnap}
            agentPaths={agentPaths}
            cwd={s.cwd}
            tree={!!panel.gitTree}
            agentOnly={!!panel.gitAgent}
            now={now}
            hidden={!gitShown}
            labelledBy={wide.value ? 'ptab-git' : 'tab-git'}
            layout={gitLayout.value}
            repoRoot={panel.gitRepo}
            onRepo={(root) => updatePanel({ gitRepo: root })}
            onTree={(on) => updatePanel({ gitTree: on })}
            onAgentOnly={(on) => updatePanel({ gitAgent: on })}
          />
          <AgentsPane
            model={agentsModel(wide.value ? panelTab !== 'agents' : t !== 'agents')}
            now={now}
            onScope={(scope) =>
              agentsMode !== 'list' &&
              updatePanel({ agScope: { ...panel.agScope, [agentsMode]: scope } })
            }
            hidden={wide.value ? panelTab !== 'agents' : t !== 'agents'}
            labelledBy={wide.value ? 'ptab-agents' : 'tab-agents'}
            onSelect={(id) => (selectedAgent.value = id)}
            onStop={stopAgent}
            onTranscript={openAgentTranscript}
            onGraph={() => openGraph(selectedAgent.value)}
          />
          {taskOn && (
            <TaskPane
              state={ts}
              chats={taskChats.value}
              provider={s.engine}
              now={now}
              hidden={wide.value ? panelTab !== 'task' : t !== 'task'}
              visible={taskShown}
              labelledBy={wide.value ? 'ptab-task' : 'tab-task'}
              seg={taskSeg}
              seen={seen}
              humanDone={humanDone}
              onSeg={(v) => updatePanel({ taskView: v })}
              onSeen={(at) => updatePanel({ taskSeen: at, taskSeenKey: taskKey })}
              onHumanDone={(id) => setHumanDone((d) => new Set(d).add(id))}
            />
          )}
        </aside>
        <nav class="rail" aria-label={ui.panel.railAria}>
          <button
            data-tip={ui.tabs.changes}
            aria-label={ui.panel.openTab(ui.tabs.changes)}
            disabled={empty}
            onClick={() => updatePanel({ tab: 'changes', off: false })}
          >
            {ICON_CHANGES}
            {changesBdg && <span class={changesBdg.live ? 'b live' : 'b'}>{changesBdg.count}</span>}
          </button>
          <button
            data-tip={ui.tabs.git}
            aria-label={ui.panel.openTab(ui.tabs.git)}
            disabled={empty}
            onClick={() => updatePanel({ tab: 'git', off: false })}
          >
            {ICON_GIT}
            {gitBdg && <span class="b">{gitBdg.count}</span>}
          </button>
          {subagents && (
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
          )}
          {taskOn && (
            <button
              data-tip={taskBdg ? ui.task.badgeTitle(taskBdg) : ui.tabs.task}
              aria-label={ui.panel.openTab(ui.tabs.task)}
              onClick={() => updatePanel({ tab: 'task', off: false })}
            >
              {ICON_TASK}
              {taskBdg > 0 && <span class="b live">{taskBdg}</span>}
            </button>
          )}
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
      <Composer key={activeTabChat.value ?? ''} />
    </div>
  );
}

/**
 * `git.watch` хосту, пока вкладка «git» видна: только тогда он считает +/− и читает лог. Скрытая панель
 * webview (вкладка редактора ушла в фон) — тоже «не видна».
 */
function useGitWatch(shown: boolean): void {
  const [docVisible, setDocVisible] = useState(document.visibilityState !== 'hidden');
  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const on = shown && docVisible;
  // вкладка задачи: показан другой чат — его git-клиенту `watch` заново (ушедший в фон снимает хост)
  const tabChat = activeTabChat.value;
  useEffect(() => {
    if (!on) return;
    send({ type: 'git.watch', on: true });
    return () => send({ type: 'git.watch', on: false });
  }, [on, tabChat]);
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
