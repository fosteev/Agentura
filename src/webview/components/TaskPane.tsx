import type { AgentProvider } from '../../agent/types';
import type { TaskEvent, TaskStateMessage } from '../../shared/task';
import type { TabChatsMessage } from '../../shared/taskTab';
import { ENGINE_MARK, ENGINE_MARK_CLASS } from '../engineLimitsView';
import { pillClass } from '../sessionsView';
import { ui } from '../strings';
import { agoLabel, eventActor, eventText, initials, issueKeyOf } from '../taskView';
import { send } from '../vscode';

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
 * вкладки «чат | задача», ключ, статус, заголовок, ссылка на задачу. На вкладке «чат», пока открыта «задача»,
 * видно, что идёт ход (спиннер и число новых записей) и что агент ждёт ответа (жёлтая точка).
 */
export function TaskStrip({
  state,
  view,
  onView,
  unseen,
  activity,
}: {
  state: TaskStateMessage & { taskKey: string };
  view: 'chat' | 'task';
  onView: (v: 'chat' | 'task') => void;
  /** Непросмотренных событий ленты — бейдж на вкладке «задача», пока она не открыта. */
  unseen: number;
  activity: ChatActivity;
}) {
  const t = ui.task;
  const card = state.card;
  const link = state.source === 'jiraffe' ? t.openJiraffe : t.openBrowser;
  const away = view === 'task';
  return (
    <div class="tk-strip" role="region" aria-label={t.stripAria}>
      <span class="vtabs" role="tablist" aria-label={t.viewAria}>
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
        <button role="tab" id="vtab-task" class={view === 'task' ? 'vtab on' : 'vtab'} aria-selected={view === 'task'} onClick={() => onView('task')}>
          {ui.tabs.task}
          {!away && unseen > 0 && (
            <i class="nb" data-tip={t.badgeTitle(unseen)}>
              {unseen}
            </i>
          )}
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
      <button class="plus" aria-label={t.tabNew} data-tip={t.tabNew} onClick={() => send({ type: 'tab.new' })}>
        ＋
      </button>
      <span class="rt">{t.tabCount(state.chats.length)}</span>
    </div>
  );
}
