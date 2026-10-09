import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import { formatSeconds } from '../../shared/jiraTools';
import {
  isIsoDate,
  TASK_LIMITS,
  type TaskActionKind,
  type TaskCard,
  type TaskChatRow,
  type TaskStateMessage,
} from '../../shared/task';
import { pillClass } from '../sessionsView';
import { taskAction, taskFocus, taskTransitions } from '../store';
import { ui } from '../strings';
import { clickedLink, sanitizeTaskHtml } from '../taskHtml';
import {
  actionErrorText,
  agoLabel,
  dateTimeLabel,
  fileExt,
  FOCUS_TTL_MS,
  focusTarget,
  humanPrompts,
  initials,
  issueKeyOf,
  latestSeen,
  parseDuration,
  sizeLabel,
  timeProgress,
  todayIso,
  unseenCount,
  visibleEvents,
} from '../taskView';
import { send, TASK_SUBS, type TaskSub } from '../vscode';
import { EventRow, Mark, SourceError } from './TaskPane';

/** HTML описания/комментария: чужая разметка проходит санитайзер, клик по ссылке уходит хосту (`task.openLink`). */
function Rich({ html, text, base, clamp }: { html: string; text: string; base: string; clamp?: boolean }) {
  const safe = useMemo(() => sanitizeTaskHtml(html, base), [html, base]);
  const [open, setOpen] = useState(false);
  // длинное описание сворачивается: по тексту — оценка «не влезет» без измерения вёрстки
  const long = !!clamp && text.length > 700;
  if (!html && !text) return null;
  const cls = `rich${long && !open ? ' clamp' : ''}`;
  return (
    <>
      {html ? (
        <div
          class={cls}
          onClick={(e) => {
            const c = clickedLink(e.target);
            if (!c.link) return;
            e.preventDefault();
            if (c.url) send({ type: 'task.openLink', url: c.url });
          }}
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      ) : (
        <div class={`${cls} plain`}>{text}</div>
      )}
      {long && (
        <button class="more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? ui.task.descLess : ui.task.descMore}
        </button>
      )}
    </>
  );
}

function Avatar({ name, mine }: { name: string; mine?: boolean }) {
  return <span class={mine ? 'av me' : 'av'}>{initials(name)}</span>;
}

/** Строки «Поля» правой колонки и сетки под заголовком узкой вкладки. */
function fieldRows(card: TaskCard): { label: string; value: string }[] {
  const t = ui.task;
  const rows: { label: string; value: string }[] = [
    { label: t.fAssignee, value: card.assignee ?? t.nobody },
    { label: t.fReporter, value: card.reporter ?? t.noValue },
  ];
  if (card.priority) rows.push({ label: t.fPriority, value: card.priority });
  if (card.components.length) rows.push({ label: t.fComponents, value: card.components.join(', ') });
  if (card.fixVersions.length) rows.push({ label: t.fVersions, value: card.fixVersions.join(', ') });
  if (card.epic) rows.push({ label: t.fEpic, value: card.epic.summary ? `${card.epic.key} ${card.epic.summary}` : card.epic.key });
  if (card.due) rows.push({ label: t.fDue, value: card.due });
  rows.push({ label: t.fCreated, value: dateTimeLabel(card.created) });
  rows.push({ label: t.fUpdated, value: dateTimeLabel(card.updatedAt) });
  return rows;
}

/** Кнопка «<статус> ▾» и меню переходов (`task.transitions`); пункт с обязательными полями неактивен. */
function StatusMenu({ card, busy, disabledTip, onPick }: { card: TaskCard; busy: boolean; disabledTip: string | undefined; onPick: (id: string) => void }) {
  const t = ui.task;
  const [open, setOpen] = useState(false);
  const [wait, setWait] = useState(false);
  const asked = useRef<unknown>(undefined);
  const root = useRef<HTMLSpanElement>(null);
  const tr = taskTransitions.value;
  useEffect(() => {
    if (tr !== asked.current) setWait(false);
  }, [tr]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc закрывает меню, а не останавливает ход (общий обработчик чата слушает window)
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const toggle = () => {
    if (open) return setOpen(false);
    asked.current = taskTransitions.peek();
    setWait(true);
    setOpen(true);
    send({ type: 'task.transitions' });
  };
  const cat = card.statusCategory === 'done' ? 'done' : card.statusCategory === 'new' ? 'new' : 'wip';
  return (
    <span class="stwrap" ref={root}>
      <button
        class={`btn st ${cat}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.statusMenu}
        disabled={!!disabledTip || busy}
        data-tip={disabledTip ?? t.statusMenu}
        onClick={toggle}
      >
        {card.status} ▾
      </button>
      {open && (
        <div class="stmenu" role="menu">
          {wait ? (
            <div class="emp">{t.transitionsLoading}</div>
          ) : tr?.error ? (
            <div class="emp err">{tr.error === 'no-writer' ? t.noWriter : tr.error}</div>
          ) : !tr || tr.items.length === 0 ? (
            <div class="emp">{t.transitionsEmpty}</div>
          ) : (
            tr.items.map((x) => (
              <button
                key={x.id}
                role="menuitem"
                class="it"
                aria-disabled={x.requiresFields ? true : undefined}
                data-tip={x.requiresFields ? t.needFields : undefined}
                onClick={() => {
                  if (x.requiresFields) return;
                  setOpen(false);
                  onPick(x.id);
                }}
              >
                <span>{x.name}</span>
                <em>→ {x.to.name}</em>
              </button>
            ))
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Вкладка «задача» (roadmap 20; `prototype/screens/task-tab.html#wide`): карточка по вёрстке Jiraffe на всю вкладку чата.
 * Слева контент (крошки, заголовок, кнопки, описание, вложения, подвкладки), справа колонка «Поля / Время / Чаты».
 * Уже 720 px поля уходят под заголовок. Описание, комментарии, названия — чужой текст: HTML — через санитайзер,
 * остальное — текстом. Запись (статус, комментарий, ворклог) идёт от имени пользователя; кнопка блокируется до `task.action`.
 */
export function TaskView({
  state,
  chats,
  provider,
  now,
  hidden,
  sub,
  seen,
  humanDone,
  waiting,
  onSub,
  onSeen,
  onToChat,
  onBackToChat,
}: {
  state: TaskStateMessage | undefined;
  chats: readonly TaskChatRow[];
  provider: AgentProvider | undefined;
  now: number;
  /** Открыта вкладка «чат»: карточка смонтирована (черновики живы), но скрыта. */
  hidden: boolean;
  sub: TaskSub;
  /** Время (мс) самого позднего события, которое уже видели. */
  seen: number;
  /** Комментарии, которые уже отправили в поле ввода («в чат»): плашка по ним закрыта. */
  humanDone: ReadonlySet<string>;
  /** Агент ждёт ответа: тост «к чату». */
  waiting: string | undefined;
  onSub: (s: TaskSub) => void;
  onSeen: (at: number) => void;
  /** «↳ в чат»: без `commentId` — вся задача, иначе комментарий. Переключение на чат делает вызывающий. */
  onToChat: (commentId?: string) => void;
  onBackToChat: () => void;
}) {
  const t = ui.task;
  const card = state?.card;
  const taskKey = state?.taskKey;
  const events = visibleEvents(state);
  const watching = !hidden && sub === 'changes';
  // «новое» подсвечивается относительно просмотра на момент открытия ленты; сама отметка «видел» сдвигается сразу
  const [baseline, setBaseline] = useState<number | undefined>(undefined);
  const newest = latestSeen(state);
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
  const unseen = watching ? 0 : unseenCount(events, seen);
  const prompts = humanPrompts(events, humanDone);
  const key = card?.key ?? (taskKey ? issueKeyOf(taskKey) : '');

  // «в задаче →» (этап 8 roadmap 19): когда событие появилось в открытой ленте — прокрутить к нему и подсветить
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

  // ---- запись от имени пользователя (решения 7, 14) ----
  const canWrite = !!card?.canWrite;
  const writeTip = card && !canWrite ? t.noWriter : undefined;
  const [pending, setPending] = useState<ReadonlySet<TaskActionKind>>(new Set());
  const [err, setErr] = useState<{ kind: TaskActionKind; text: string } | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [wlOpen, setWlOpen] = useState(false);
  const [wlTime, setWlTime] = useState('');
  const [wlDate, setWlDate] = useState(todayIso);
  const [wlComment, setWlComment] = useState('');
  const [wlBad, setWlBad] = useState(false);
  const act = taskAction.value;
  const lastAct = useRef(act);
  useEffect(() => {
    if (!act || act === lastAct.current) return;
    lastAct.current = act;
    setPending((p) => {
      const n = new Set(p);
      n.delete(act.kind);
      return n;
    });
    if (act.ok) {
      setErr(undefined);
      if (act.kind === 'comment') setDraft('');
      if (act.kind === 'logWork') {
        setWlOpen(false);
        setWlTime('');
        setWlComment('');
        setWlBad(false);
      }
    } else setErr({ kind: act.kind, text: actionErrorText(act.error) });
  }, [act]);
  // другая задача — ни незавершённых записей, ни ошибок, ни черновиков прежней
  useEffect(() => {
    setPending(new Set());
    setErr(undefined);
    setDraft('');
    setWlOpen(false);
  }, [taskKey]);
  const begin = (kind: TaskActionKind) => {
    setErr(undefined);
    setPending((p) => new Set(p).add(kind));
  };
  const sendComment = () => {
    const body = draft.trim();
    if (!body || body.length > TASK_LIMITS.comment || pending.has('comment') || !canWrite) return;
    begin('comment');
    send({ type: 'task.comment', body: draft });
  };
  const sendWork = () => {
    const seconds = parseDuration(wlTime);
    if (seconds === undefined || !isIsoDate(wlDate)) {
      setWlBad(true);
      return;
    }
    setWlBad(false);
    begin('logWork');
    send({ type: 'task.logWork', seconds, date: wlDate, comment: wlComment });
  };
  const stopKeys = (e: KeyboardEvent) => {
    // Esc в поле ввода не должен останавливать ход (общий обработчик чата)
    if (e.key === 'Escape') {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).blur();
    }
  };

  const counts = {
    comments: card?.comments.length ?? 0,
    history: card?.history.length ?? 0,
    worklog: card?.worklogs.length ?? 0,
    changes: unseen,
  };
  const freshComments = card ? card.comments.some((c) => c.at > 0 && c.at > mark) : false;
  const time = card?.time;
  const progress = time ? timeProgress(time) : undefined;
  const fields = card ? fieldRows(card) : [];

  return (
    <section ref={root} class="tv" id="pane-task" aria-label={t.stripAria} hidden={hidden}>
      <div class="tv-main">
        {state && <SourceError state={state} />}
        {!card ? (
          !state?.error && <div class="tv-load">{t.loading}</div>
        ) : (
          <>
            <div class="crumb">
              <span class="tkey">{key}</span>
              <span>·</span>
              <span>{card.type || t.crumb}</span>
              <span class="sp" />
              <button class="rf" data-tip={t.refresh} aria-label={t.refresh} onClick={() => send({ type: 'task.refresh' })}>
                ↻
              </button>
              <span class="upd">{t.updated(agoLabel(state?.fetchedAt ?? 0, now))}</span>
            </div>
            <h1>{card.title}</h1>
            <div class="bar">
              <StatusMenu
                card={card}
                busy={pending.has('transition')}
                disabledTip={writeTip}
                onPick={(id) => {
                  begin('transition');
                  send({ type: 'task.transition', transitionId: id });
                }}
              />
              <button class="btn" disabled={!canWrite} data-tip={writeTip} aria-expanded={wlOpen} onClick={() => setWlOpen(!wlOpen)}>
                {t.worklogBtn}
              </button>
              <button class="btn pri" data-tip={t.toChatCardTitle} onClick={() => onToChat()}>
                {t.toChatCard}
              </button>
            </div>
            {err?.kind === 'transition' && (
              <div class="act-err" role="alert">
                {err.text}
              </div>
            )}
            {wlOpen && (
              <form
                class="wlform"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendWork();
                }}
              >
                <label>
                  <span>{t.wlTime}</span>
                  <input
                    value={wlTime}
                    placeholder={t.wlTimePh}
                    maxLength={20}
                    aria-invalid={wlBad ? true : undefined}
                    onInput={(e) => setWlTime((e.target as HTMLInputElement).value)}
                    onKeyDown={stopKeys}
                  />
                </label>
                <label>
                  <span>{t.wlDate}</span>
                  <input
                    type="date"
                    value={wlDate}
                    onInput={(e) => setWlDate((e.target as HTMLInputElement).value)}
                    onKeyDown={stopKeys}
                  />
                </label>
                <label class="wide">
                  <span>{t.wlComment}</span>
                  <input
                    value={wlComment}
                    maxLength={TASK_LIMITS.workComment}
                    onInput={(e) => setWlComment((e.target as HTMLInputElement).value)}
                    onKeyDown={stopKeys}
                  />
                </label>
                <span class="acts">
                  <button class="btn pri" type="submit" disabled={pending.has('logWork')}>
                    {pending.has('logWork') ? t.sending : t.wlSave}
                  </button>
                  <button class="btn" type="button" onClick={() => setWlOpen(false)}>
                    {t.wlCancel}
                  </button>
                </span>
                {wlBad && (
                  <div class="act-err" role="alert">
                    {t.wlBadTime}
                  </div>
                )}
                {err?.kind === 'logWork' && (
                  <div class="act-err" role="alert">
                    {err.text}
                  </div>
                )}
              </form>
            )}
            <div class="meta">
              {fields.map((f) => (
                <div key={f.label}>
                  <span>{f.label}</span>
                  <b>{f.value}</b>
                </div>
              ))}
            </div>
            <h4>{t.description}</h4>
            {card.description || card.descriptionHtml ? (
              <Rich html={card.descriptionHtml} text={card.description} base={card.url} clamp />
            ) : (
              <div class="empty">{t.noDescription}</div>
            )}
            {card.attachments.length > 0 && (
              <>
                <h4>
                  {t.attachments}
                  <em>{card.attachments.length}</em>
                </h4>
                <div class="atts">
                  {card.attachments.map((a) => (
                    <button key={a.id} class="att" data-tip={t.attachmentTitle} onClick={() => send({ type: 'task.openExternal', attachmentId: a.id })}>
                      <span class="th">.{fileExt(a.filename)}</span>
                      <span class="nm">{a.filename}</span>
                      <span class="sz">{sizeLabel(a.size)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div class="subtabs" role="tablist" aria-label={t.subAria}>
              {TASK_SUBS.map((k) => (
                <button key={k} role="tab" class={sub === k ? 'on' : ''} aria-selected={sub === k} onClick={() => onSub(k)}>
                  {t.sub[k]}
                  {(k !== 'changes' || counts.changes > 0) && (
                    <i class={`cnt${(k === 'comments' && freshComments) || k === 'changes' ? ' nw' : ''}`}>{counts[k]}</i>
                  )}
                </button>
              ))}
            </div>
            {sub === 'comments' && (
              <div class="subbody">
                {card.comments.length === 0 && <div class="empty">{t.noComments}</div>}
                {card.comments.map((c) => {
                  const fresh = c.at > 0 && c.at > mark;
                  return (
                    <div key={c.id} class={fresh ? 'cmt new' : 'cmt'} data-comment={c.id}>
                      <Avatar name={c.author} mine={c.mine} />
                      <div class="cb">
                        <div class="w">
                          <b>{c.author}</b>
                          <span>· {agoLabel(c.at, now)}</span>
                          {fresh && <span class="nw">{t.freshAgo(agoLabel(c.at, now))}</span>}
                        </div>
                        <Rich html={c.html} text={c.text} base={card.url} />
                      </div>
                      <button class="tochat" data-tip={t.toChatTitle} onClick={() => onToChat(c.id)}>
                        {t.toChatCard}
                      </button>
                    </div>
                  );
                })}
                <div class="reply">
                  <textarea
                    value={draft}
                    rows={2}
                    maxLength={TASK_LIMITS.comment}
                    placeholder={t.commentPh}
                    aria-label={t.commentAria}
                    disabled={!canWrite}
                    data-tip={writeTip}
                    onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
                    onKeyDown={(e) => {
                      stopKeys(e);
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
                        e.preventDefault();
                        sendComment();
                      }
                    }}
                  />
                  <button
                    class="btn pri"
                    disabled={!canWrite || !draft.trim() || pending.has('comment')}
                    data-tip={t.commentHint}
                    onClick={sendComment}
                  >
                    {pending.has('comment') ? t.sending : t.commentSend}
                  </button>
                </div>
                {err?.kind === 'comment' && (
                  <div class="act-err" role="alert">
                    {err.text}
                  </div>
                )}
              </div>
            )}
            {sub === 'history' && (
              <div class="subbody">
                {card.history.length === 0 && <div class="empty">{t.historyEmpty}</div>}
                {[...card.history].reverse().map((h, i) => (
                  <div key={`${h.at}:${i}`} class="hist">
                    <div class="w">
                      <b>{h.author}</b>
                      <span>· {dateTimeLabel(h.at)}</span>
                    </div>
                    {h.items.map((it, j) => (
                      <div key={j} class="hi">
                        <span>{it.field}</span>
                        <em>
                          {it.from ?? t.noValue} → <b>{it.to ?? t.noValue}</b>
                        </em>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {sub === 'worklog' && (
              <div class="subbody">
                {card.worklogs.length === 0 && <div class="empty">{t.worklogEmpty}</div>}
                {[...card.worklogs].reverse().map((w) => (
                  <div key={w.id} class="wl">
                    <Avatar name={w.author} mine={w.mine} />
                    <div class="cb">
                      <div class="w">
                        <b>{w.author}</b>
                        <span>· {dateTimeLabel(w.at)}</span>
                        <span class="dur">{formatSeconds(w.seconds)}</span>
                      </div>
                      {w.comment && <div class="txt">{w.comment}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {sub === 'changes' && (
              <div class="subbody">
                {prompts.map((p) => (
                  <div key={p.id} class="tk-ban" data-comment={p.commentId}>
                    <span>{t.banner(p.author)}</span>
                    <button
                      class="btn"
                      data-tip={t.toChatTitle}
                      onClick={() => {
                        if (p.commentId) onToChat(p.commentId);
                      }}
                    >
                      {t.toChat}
                    </button>
                  </div>
                ))}
                <div class="tk-feedh">{t.feedHeadAll}</div>
                <div class="evs">
                  {events.length === 0 ? (
                    <div class="empty">{t.feedEmpty}</div>
                  ) : (
                    events.map((e) => (
                      <EventRow key={e.id} e={e} fresh={e.at > mark} focused={e.id === focused} provider={provider} now={now} />
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <aside class="tv-side" aria-label={t.paneAria}>
        {card && (
          <>
            <div class="fields">
              <h5>{t.fieldsHead}</h5>
              <div class="kv">
                <span>{t.status}</span>
                <b>
                  <span class={`pill ${pillClass(card.statusCategory)}`}>{card.status}</span>
                </b>
                {fields.map((f) => (
                  <Fragment key={f.label}>
                    <span>{f.label}</span>
                    <b title={f.value}>{f.value}</b>
                  </Fragment>
                ))}
                {card.labels.length > 0 && (
                  <>
                    <span>{t.fLabels}</span>
                    <b class="tags">
                      {card.labels.map((l) => (
                        <span key={l} class="tkey">
                          {l}
                        </span>
                      ))}
                    </b>
                  </>
                )}
              </div>
            </div>
            {!!(time?.spentSec || time?.originalSec || time?.remainingSec) && (
              <div class="time">
                <h5>{t.timeHead}</h5>
                <div class="tm2">
                  <span>{t.logged}</span>
                  <b>
                    {formatSeconds(time?.spentSec ?? 0)}
                    {time?.originalSec ? ` ${t.of} ${formatSeconds(time.originalSec)}` : ''}
                  </b>
                  {progress !== undefined && (
                    <span class="bar2" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                      <i style={{ width: `${progress}%` }} />
                    </span>
                  )}
                  {time?.remainingSec !== undefined && time.remainingSec > 0 && (
                    <>
                      <span>{t.remaining}</span>
                      <b>{formatSeconds(time.remainingSec)}</b>
                    </>
                  )}
                </div>
              </div>
            )}
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
                <button key={c.id} class="r" data-tip={t.openChatTitle} onClick={() => send({ type: 'task.openChat', sessionId: c.id })}>
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
      </aside>
      {waiting && !hidden && (
        <div class="toast2" role="status">
          <Mark provider={provider} />
          <span>{t.waitToast(waiting)}</span>
          <button onClick={onBackToChat}>{t.waitBack}</button>
        </div>
      )}
    </section>
  );
}
