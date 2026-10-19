import { useEffect, useState } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import type { TaskChatRow, TaskEvent, TaskStateMessage } from '../../shared/task';
import type { TabChatsMessage } from '../../shared/taskTab';
import { ENGINE_MARK, ENGINE_MARK_CLASS } from '../engineLimitsView';
import { pillClass } from '../sessionsView';
import { ui } from '../strings';
import { startNewChat } from '../newChat';
import { agoLabel, eventActor, eventText, initials, issueKeyOf, stripChats } from '../taskView';
import { send, type TaskViewName } from '../vscode';

export function Mark({ provider }: { provider: AgentProvider | undefined }) {
  const e = provider ?? 'claude';
  return <i class={`mk ${ENGINE_MARK_CLASS[e]}`}>{ENGINE_MARK[e]}</i>;
}

/** Строка ошибки источника: причина, подсказка и «подключить» / «повторить» по коду. */
export function SourceError({ state }: { state: TaskStateMessage }) {
  const err = state.error;
  if (!err) return null;
  const connect = err.code === 'no-source' || err.code === 'unknown-instance' || err.code === 'auth';
  const retry = err.code !== 'off' && err.code !== 'no-source';
  return (
    <div class="tk-err" role="alert" data-code={err.code}>
      <span>
        {err.message}
        {err.code === 'auth' && ` ${ui.task.authHint}`}
        {state.card && err.code !== 'off' && ` ${ui.task.staleHint}`}
      </span>
      <span class="acts">
        {connect && (
          <button class="btn" onClick={() => send({ type: 'task.connect' })}>
            {ui.task.connect}
          </button>
        )}
        {retry && (
          <button class="btn" onClick={() => send({ type: 'task.refresh' })}>
            {ui.task.retry}
          </button>
        )}
      </span>
    </div>
  );
}

export function EventRow({
  e,
  fresh,
  focused,
  provider,
  now,
}: {
  e: TaskEvent;
  fresh: boolean;
  /** К событию привёл «в задаче →» строки инструмента Jira. */
  focused?: boolean;
  provider: AgentProvider | undefined;
  now: number;
}) {
  const t = ui.task;
  const actor = eventActor(e);
  const body = eventText(e);
  return (
    <div
      class={`tk-evt${actor === 'human' ? ' hum' : ''}${fresh ? ' new' : ''}${focused ? ' focus' : ''}`}
      data-kind={e.kind}
      data-id={e.id}
    >
      {actor === 'agent' ? (
        <span class="av2 ag">
          <Mark provider={provider} />
        </span>
      ) : (
        <span class="av2">{initials(e.author)}</span>
      )}
      <div>
        <div class="h">
          <b>{actor === 'agent' ? t.agent : e.author}</b>
          <span>
            {actor === 'agent' ? t.onBehalf(e.author) : actor === 'human' ? t.human : t.you}
          </span>
          {fresh && <span class="nw">{t.freshAgo(agoLabel(e.at, now))}</span>}
          <span class="tm">{agoLabel(e.at, now)}</span>
        </div>
        <div class="bd">
          {body.label}: {body.text}
          {body.strong && <b>{body.strong}</b>}
        </div>
        {e.fromThisChat && <span class="fr">{t.fromChat}</span>}
      </div>
    </div>
  );
}

/** Что идёт в чате, пока открыта «задача» (roadmap 20, решение 9): ход, число новых записей ленты, ожидание ответа. */
export interface ChatActivity {
  /** Идёт ход (в том числе когда агент ждёт ответа). */
  working: boolean;
  /** Агент ждёт ответа (разрешение / вопрос / план). */
  waiting: boolean;
  /** Новых записей ленты с момента переключения на «задачу». */
  fresh: number;
  /** Подпись «ход 1:12»; нет — не показывать. */
  run?: string;
}

/**
 * Полоса задачи над лентой чата (решение 8 roadmap 19, вкладки — решение 1 roadmap 20; `task-tab.html`, `.strip.vt`):
 * вкладки «чат | задача | код», ключ, статус, заголовок, ссылка на задачу. На вкладке «чат», пока открыта другая,
 * видно, что идёт ход (спиннер и число новых записей) и что агент ждёт ответа (жёлтая точка). «код» (roadmap 24) —
 * коммиты, ветки и правки агентов по задаче; число — коммиты + незакоммиченные файлы, пока не загружено — без числа.
 */
export function TaskStrip({
  state,
  view,
  onView,
  unseen,
  activity,
  codeCount,
  chats,
}: {
  state: TaskStateMessage & { taskKey: string };
  view: TaskViewName;
  onView: (v: TaskViewName) => void;
  /** Непросмотренных событий ленты — бейдж на вкладке «задача», пока она не открыта. */
  unseen: number;
  activity: ChatActivity;
  /** Число у вкладки «код»; нет — вкладка ещё не загружалась. */
  codeCount?: number;
  /**
   * Чаты задачи (`task.chats`): вместо вкладки «чат» — чипы чатов и «＋ чат» (roadmap 26, решение 11). Нет — прежняя
   * вкладка «чат» (режим `tasks.tab = task`, где чаты уже во внутренних вкладках, и превью настроек).
   */
  chats?: readonly TaskChatRow[];
}) {
  const t = ui.task;
  const card = state.card;
  const link = state.source === 'jiraffe' ? t.openJiraffe : t.openBrowser;
  const away = view !== 'chat';
  return (
    <div class="tk-strip" role="region" aria-label={t.stripAria}>
      <span class="vtabs" role="tablist" aria-label={t.viewAria}>
        {chats ? (
          <ChatChips state={state} chats={chats} view={view} onView={onView} activity={activity} />
        ) : (
          <button role="tab" id="vtab-chat" class={view === 'chat' ? 'vtab on' : 'vtab'} aria-selected={view === 'chat'} onClick={() => onView('chat')}>
            {ui.tabs.chat}
            {away && activity.waiting && <span class="wt" role="img" aria-label={t.waitDotTitle} data-tip={t.waitDotTitle} />}
            {away && !activity.waiting && activity.working && (
              <>
                <span class="spin" role="img" aria-label={t.turnTitle} data-tip={t.turnTitle} />
                {activity.fresh > 0 && <i class="nb">{activity.fresh}</i>}
              </>
            )}
          </button>
        )}
        <button role="tab" id="vtab-task" class={view === 'task' ? 'vtab on' : 'vtab'} aria-selected={view === 'task'} onClick={() => onView('task')}>
          {ui.tabs.task}
          {view !== 'task' && unseen > 0 && (
            <i class="nb" data-tip={t.badgeTitle(unseen)}>
              {unseen}
            </i>
          )}
        </button>
        <button role="tab" id="vtab-code" class={view === 'code' ? 'vtab on' : 'vtab'} aria-selected={view === 'code'} data-tip={t.code.tabTitle} onClick={() => onView('code')}>
          {ui.tabs.code}
          {codeCount !== undefined && <i class="cnt">{codeCount}</i>}
        </button>
      </span>
      <span class="sep" />
      <span class="tkey">{card?.key ?? issueKeyOf(state.taskKey)}</span>
      {card && <span class={`pill ${pillClass(card.statusCategory)}`}>{card.status}</span>}
      <span class="ttl" title={card?.title}>
        {card?.title ?? t.untitled}
      </span>
      {away && activity.working && activity.run && <span class="run">{activity.run}</span>}
      {card && (
        <button class="lnk" data-tip={t.openTitle} onClick={() => send({ type: 'task.openExternal' })}>
          {link}
        </button>
      )}
    </div>
  );
}

/** Индикаторы текущего чата, пока открыта «задача»/«код»: ждёт ответа — жёлтая точка, идёт ход — спиннер и число новых. */
function ActivityMarks({ activity }: { activity: ChatActivity }) {
  const t = ui.task;
  return (
    <>
      {activity.waiting && <span class="wt" role="img" aria-label={t.waitDotTitle} data-tip={t.waitDotTitle} />}
      {!activity.waiting && activity.working && (
        <>
          <span class="spin" role="img" aria-label={t.turnTitle} data-tip={t.turnTitle} />
          {activity.fresh > 0 && <i class="nb">{activity.fresh}</i>}
        </>
      )}
    </>
  );
}

/**
 * Чипы чатов задачи вместо вкладки «чат» (roadmap 26, решение 11; `task-chats.html#strip`): текущий чат — вкладка вида
 * «чат» с индикаторами хода, остальные — точка состояния и переход `task.openChat`; нет строки текущего — первым
 * идёт чип «новый чат». Больше четырёх — текущий и три последних, остальные в меню «ещё N ▾». Затем «＋ чат»:
 * клик — всплывашка, ⌥+клик — сразу.
 */
function ChatChips({
  state,
  chats,
  view,
  onView,
  activity,
}: {
  state: TaskStateMessage & { taskKey: string };
  chats: readonly TaskChatRow[];
  view: TaskViewName;
  onView: (v: TaskViewName) => void;
  activity: ChatActivity;
}) {
  const t = ui.task;
  const away = view !== 'chat';
  const { shown, hidden, synthetic } = stripChats(chats);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!more) return;
    const off = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('.cmore')) setMore(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMore(false);
    document.addEventListener('pointerdown', off, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', off, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [more]);
  const menuOpen = more && hidden.length > 0;

  const current = (c: TaskChatRow | undefined) => {
    const label = c?.title || t.tabUntitled;
    return (
      <button
        key={c?.id ?? 'new'}
        role="tab"
        id="vtab-chat"
        class={view === 'chat' ? 'cc cur on' : 'cc cur'}
        aria-selected={view === 'chat'}
        data-tip={label}
        onClick={() => onView('chat')}
      >
        <Mark provider={c?.provider} />
        <span class="n">{label}</span>
        {away && <ActivityMarks activity={activity} />}
      </button>
    );
  };
  const other = (c: TaskChatRow) => {
    const label = c.title || t.tabUntitled;
    const st = c.state === 'idle' ? undefined : t.chipState[c.state];
    return (
      <button
        key={c.id}
        role="tab"
        class="cc"
        aria-selected={false}
        data-state={c.state}
        data-tip={t.chipTitle(label, st)}
        onClick={() => send({ type: 'task.openChat', sessionId: c.id })}
      >
        <Mark provider={c.provider} />
        <span class="n">{label}</span>
        {st && <span class={`lv ${c.state}`} role="img" aria-label={st} />}
      </button>
    );
  };
  return (
    <>
      {synthetic && current(undefined)}
      {shown.map((c) => (c.current ? current(c) : other(c)))}
      {hidden.length > 0 && (
        <span class="cmore">
          <button
            class="cc more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-tip={t.chipMoreTitle}
            onClick={() => setMore(!more)}
          >
            {t.chipMore(hidden.length)}
          </button>
          {menuOpen && (
            <div class="cmenu" role="menu">
              {hidden.map((c) => {
                const st = c.state === 'idle' ? undefined : t.chipState[c.state];
                return (
                  <button
                    key={c.id}
                    role="menuitem"
                    class="it"
                    onClick={() => {
                      setMore(false);
                      send({ type: 'task.openChat', sessionId: c.id });
                    }}
                  >
                    <Mark provider={c.provider} />
                    <span class="n">{c.title || t.tabUntitled}</span>
                    {st && <span class={`lv ${c.state}`} role="img" aria-label={st} />}
                  </button>
                );
              })}
            </div>
          )}
        </span>
      )}
      <button class="np" aria-label={t.newChatBtnTitle} data-tip={t.newChatBtnTitle} onClick={(e) => startNewChat(e, state.taskKey)}>
        <b aria-hidden="true">＋</b>
        {t.newChatBtn}
      </button>
      <span class="sep" />
    </>
  );
}

/**
 * Внутренние вкладки вкладки на задачу (`tasks.tab = task`, этап 7, `tasks.html#b`/`#d`): чаты задачи под полоской,
 * «×» закрывает чат, «＋» — новый чат по задаче. Точка — статус чата (у фонового «ждёт ответа» видно сразу).
 */
export function ChatTabs({ state }: { state: TabChatsMessage }) {
  const t = ui.task;
  return (
    <div class="tk-ctabs" role="tablist" aria-label={t.tabsAria}>
      {state.chats.map((c) => {
        const label = c.title || t.tabUntitled;
        const status = c.status === 'idle' ? undefined : t.tabStatus[c.status];
        return (
          <span key={c.id} class={c.active ? 'ctab on' : 'ctab'} data-status={c.status}>
            <button
              role="tab"
              class="cn"
              aria-selected={c.active}
              data-tip={status ? `${label} · ${status}` : label}
              onClick={() => !c.active && send({ type: 'tab.select', id: c.id })}
            >
              {status && <span class={`dot ${c.status}`} aria-label={status} />}
              <Mark provider={c.provider} />
              <span class="n">{label}</span>
            </button>
            <button class="x" aria-label={t.tabClose} data-tip={t.tabClose} onClick={() => send({ type: 'tab.close', id: c.id })}>
              ×
            </button>
          </span>
        );
      })}
      <button class="plus" aria-label={t.tabNew} data-tip={t.tabNew} onClick={(e) => startNewChat(e, state.taskKey)}>
        ＋
      </button>
      <span class="rt">{t.tabCount(state.chats.length)}</span>
    </div>
  );
}
