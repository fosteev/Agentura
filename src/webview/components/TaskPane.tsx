import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import type { TaskChatRow, TaskEvent, TaskStateMessage } from '../../shared/task';
import type { TabChatsMessage } from '../../shared/taskTab';
import { ENGINE_MARK, ENGINE_MARK_CLASS } from '../engineLimitsView';
import { pillClass } from '../sessionsView';
import { ui } from '../strings';
import {
  agoLabel,
  descriptionLong,
  eventActor,
  eventText,
  focusTarget,
  FOCUS_TTL_MS,
  humanPrompts,
  initials,
  issueKeyOf,
  sizeLabel,
  unseenCount,
  latestSeen,
  visibleEvents,
} from '../taskView';
import { send } from '../vscode';
import { taskFocus } from '../store';

export type TaskSeg = 'card' | 'changes';

function Mark({ provider }: { provider: AgentProvider | undefined }) {
  const e = provider ?? 'claude';
  return <i class={`mk ${ENGINE_MARK_CLASS[e]}`}>{ENGINE_MARK[e]}</i>;
}

/** Текст (описание, комментарий) — только `textContent`: из Jira приходит чужой текст. Длинный сворачивается с «ещё». */
function Clamped({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  const long = descriptionLong(text);
  return (
    <>
      <div class={open || !long ? 'tk-txt' : 'tk-txt clamp'} style={{ '--lines': lines }}>
        {text}
      </div>
      {long && (
        <button class="more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? ui.task.less : ui.task.more}
        </button>
      )}
    </>
  );
}

/** Строка ошибки источника: причина, подсказка и «подключить» / «повторить» по коду. */
function SourceError({ state }: { state: TaskStateMessage }) {
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

function EventRow({
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

/**
 * Вкладка «задача» правой панели (roadmap 19, этап 5; `prototype/screens/task-mode.html`): переключатель «карточка |
 * изменения», шапка задачи, ошибка источника, тело и закреплённый внизу блок «Чаты по задаче».
 * Описание, комментарии, названия — чужой текст: рисуется текстом.
 */
export function TaskPane({
  state,
  chats,
  provider,
  now,
  hidden,
  visible,
  labelledBy,
  seg,
  seen,
  humanDone,
  onSeg,
  onSeen,
  onHumanDone,
}: {
  state: TaskStateMessage | undefined;
  chats: readonly TaskChatRow[];
  provider: AgentProvider | undefined;
  now: number;
  /** Вкладка не выбрана (скрыт `<section>`). */
  hidden: boolean;
  /** Вкладка выбрана и панель на экране — только тогда «изменения» считаются просмотренными. */
  visible: boolean;
  labelledBy: string;
  seg: TaskSeg;
  /** Время (мс) самого позднего события, которое уже видели. */
  seen: number;
  /** Комментарии, которые уже отправили в поле ввода («в чат»): плашка по ним закрыта. */
  humanDone: ReadonlySet<string>;
  onSeg: (s: TaskSeg) => void;
  onSeen: (at: number) => void;
  onHumanDone: (commentId: string) => void;
}) {
  const t = ui.task;
  const events = visibleEvents(state);
  const watching = visible && seg === 'changes';
  // «новое» подсвечивается относительно просмотра на момент открытия ленты; сама отметка «видел» сдвигается сразу
  const [baseline, setBaseline] = useState<number | undefined>(undefined);
  // «видел» — и события, и комментарии карточки (при `humanChanges = false` чужие комментарии в ленту не попадают,
  // но подсвечиваются в карточке относительно той же отметки)
  const newest = latestSeen(state);
  const taskKey = state?.taskKey;
  // другая задача — отсчёт подсветки заново (эффект раньше следующего: тот выставит новую базу)
  useEffect(() => setBaseline(undefined), [taskKey]);
  useEffect(() => {
    if (!watching) {
      setBaseline(undefined);
      return;
    }
    // отметки ещё нет (`Infinity` — первая загрузка не пришла или отметка чужой задачи) — базу не фиксируем
    if (!Number.isFinite(seen)) return;
    setBaseline((b) => b ?? seen);
    if (newest > seen) onSeen(newest);
  }, [watching, newest, seen, taskKey]);
  const mark = baseline ?? seen;
  const card = state?.card;
  // открытая лента — бейджа в переключателе нет (отметка сдвигается после кадра)
  const unseen = watching ? 0 : unseenCount(events, seen);
  const prompts = humanPrompts(events, humanDone);
  const key = card?.key ?? (taskKey ? issueKeyOf(taskKey) : '');
  // «в задаче →» (этап 8): когда событие появилось в открытой ленте — прокрутить к нему и подсветить
  const root = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const focus = taskFocus.value;
  const target = watching ? focusTarget(events, focus) : undefined;
  useEffect(() => {
    if (focus && Date.now() - focus.since > FOCUS_TTL_MS) taskFocus.value = undefined;
    if (!target) return;
    taskFocus.value = undefined;
    setFocused(target.id);
    const el = [...(root.current?.querySelectorAll<HTMLElement>('.tk-evt') ?? [])].find((x) => x.dataset['id'] === target.id);
    el?.scrollIntoView?.({ block: 'center' });
  }, [target?.id, focus, state?.fetchedAt]);
  useEffect(() => {
    if (!focused) return;
    const h = setTimeout(() => setFocused(undefined), 4000);
    return () => clearTimeout(h);
  }, [focused]);
  return (
    <section
      ref={root}
      class="tabpane tkp"
      id="pane-task"
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
    >
      <div class="tk-seg" role="group" aria-label={t.segAria}>
        <button aria-pressed={seg === 'card'} onClick={() => onSeg('card')}>
          {t.segCard}
        </button>
        <button aria-pressed={seg === 'changes'} onClick={() => onSeg('changes')}>
          {t.segChanges}
          {unseen > 0 && <span class="b">{unseen}</span>}
        </button>
      </div>
      <div class="tk-ph">
        <div class="l1">
          <span class="tkey">{key}</span>
          {card && <span class={`pill ${pillClass(card.statusCategory)}`}>{card.status}</span>}
          <span class="sp" />
          <button class="refresh" data-tip={t.refresh} aria-label={t.refresh} onClick={() => send({ type: 'task.refresh' })}>
            ↻
          </button>
          <span class="upd">{t.updated(agoLabel(state?.fetchedAt ?? 0, now))}</span>
        </div>
        {card && (
          <div class="l2">
            {t.assignee} <b>{card.assignee ?? t.nobody}</b>
            {card.priority && (
              <>
                {' · '}
                {t.priority} <b>{card.priority}</b>
              </>
            )}
          </div>
        )}
      </div>
      {state && <SourceError state={state} />}
      {seg === 'card' ? (
        <div class="tk-body">
          {!card ? (
            !state?.error && <div class="empty">{t.loading}</div>
          ) : (
            <>
              <div>
                <h5>{t.description}</h5>
                {card.description ? <Clamped text={card.description} lines={4} /> : <div class="empty">{t.noDescription}</div>}
              </div>
              {card.attachments.length > 0 && (
                <div>
                  <h5>
                    {t.attachments}
                    <em>{card.attachments.length}</em>
                  </h5>
                  <div class="chips">
                    {card.attachments.map((a) => (
                      <button
                        key={a.id}
                        class="chip2"
                        data-tip={t.attachmentTitle}
                        onClick={() => send({ type: 'task.openExternal', attachmentId: a.id })}
                      >
                        {a.filename} <i>{sizeLabel(a.size)}</i>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h5>
                  {t.comments}
                  <em>
                    {card.comments.length} · {t.newestBottom}
                  </em>
                </h5>
                {card.comments.length === 0 && <div class="empty">{t.noComments}</div>}
                {card.comments.map((c) => {
                  const fresh = c.at > 0 && c.at > mark;
                  return (
                    <div key={c.id} class={fresh ? 'tk-cm new' : 'tk-cm'} data-comment={c.id}>
                      <div class="w">
                        <b>{c.author}</b> · {agoLabel(c.at, now)}
                        {fresh && <span class="nw">{t.freshAgo(agoLabel(c.at, now))}</span>}
                      </div>
                      <Clamped text={c.text} lines={3} />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          {prompts.map((p) => (
            <div key={p.id} class="tk-ban" data-comment={p.commentId}>
              <span>{t.banner(p.author)}</span>
              <button
                class="btn"
                data-tip={t.toChatTitle}
                onClick={() => {
                  if (!p.commentId) return;
                  send({ type: 'task.toComposer', commentId: p.commentId });
                  onHumanDone(p.commentId);
                }}
              >
                {t.toChat}
              </button>
            </div>
          ))}
          <div class="tk-feedh">{t.feedHeadAll}</div>
          <div class="tk-body evs">
            {events.length === 0 ? (
              <div class="empty">{t.feedEmpty}</div>
            ) : (
              events.map((e) => (
                <EventRow key={e.id} e={e} fresh={e.at > mark} focused={e.id === focused} provider={provider} now={now} />
              ))
            )}
          </div>
        </>
      )}
      {taskKey && (
        <div class="tk-chats">
          <h5>
            {t.chats}
            <em>{chats.length}</em>
          </h5>
          {chats.map((c) =>
            c.current ? (
              <div key={c.id} class="r cur" aria-current="true">
                <Mark provider={c.provider} />
                <span>
                  <span class="dot" />
                  {c.title} <em>· {t.thisChat}</em>
                </span>
                <em>{agoLabel(c.updatedAt, now)}</em>
              </div>
            ) : (
              <button
                key={c.id}
                class="r"
                data-tip={t.openChatTitle}
                onClick={() => send({ type: 'task.openChat', sessionId: c.id })}
              >
                <Mark provider={c.provider} />
                <span>{c.title}</span>
                <em>{agoLabel(c.updatedAt, now)}</em>
              </button>
            ),
          )}
          <button class="newchat" data-tip={t.newChatTitle} onClick={() => send({ type: 'task.newChat', taskKey })}>
            <span aria-hidden="true">＋</span>
            <span>{t.newChat}</span>
          </button>
        </div>
      )}
    </section>
  );
}

/** Полоска задачи над лентой чата (решение 8; `task-mode.html#open`): ключ, статус, заголовок, ссылка на задачу. */
export function TaskStrip({ state }: { state: TaskStateMessage & { taskKey: string } }) {
  const t = ui.task;
  const card = state.card;
  const link = state.source === 'jiraffe' ? t.openJiraffe : t.openBrowser;
  return (
    <div class="tk-strip" role="region" aria-label={t.stripAria}>
      <span class="tkey">{card?.key ?? issueKeyOf(state.taskKey)}</span>
      {card && <span class={`pill ${pillClass(card.statusCategory)}`}>{card.status}</span>}
      <span class="ttl" title={card?.title}>
        {card?.title ?? t.untitled}
      </span>
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
