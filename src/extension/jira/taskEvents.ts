import { htmlToText } from '../../data/jira/text';
import type { Attachment, IssueDetail, Worklog } from '../../data/jira/types';
import type { TaskAttachment, TaskCard, TaskComment, TaskEvent, TaskHistory, TaskWorklog } from '../../shared/task';

/** Ход сессии: `end` нет, пока ход идёт. Мс эпохи. */
export interface TurnSpan {
  start: number;
  end?: number;
}

/** Запас после конца хода: запись в Jira доходит до сервера с задержкой, а лента опрашивается позже. */
export const FROM_CHAT_SLACK_MS = 60_000;
/** Сколько событий держит лента. */
export const MAX_EVENTS = 100;
const MAX_DESCRIPTION = 20_000;
const MAX_COMMENT = 4_000;
/** HTML описания и одного комментария для вкладки «задача» (roadmap 20) — по символам, обрезка может порвать тег. */
export const MAX_HTML = 200_000;
/** Записей истории и ворклогов в карточке (лента изменений берёт свои из полного перечня). */
export const MAX_CARD_ROWS = 200;
/** Короткие поля (имя, статус, ключ, имя файла) и число записей каждого вида в снимке. */
const MAX_FIELD = 500;
const MAX_ITEMS = 500;

// Данные источника недоверенные (Jiraffe — чужое расширение, свой клиент — ответ сервера): типы и длины — здесь.
const str = (v: unknown, n = MAX_FIELD): string => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) : v) : '');
const arr = <T>(v: readonly T[] | undefined): readonly T[] => (Array.isArray(v) ? v.slice(-MAX_ITEMS) : []);
const strs = (v: readonly unknown[] | undefined): string[] => arr(v).filter((x): x is string => typeof x === 'string').map((x) => str(x));
const secs = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const CATEGORIES = ['new', 'indeterminate', 'done'] as const;

/** Текущий пользователь Jira: `id` — то, с чем сравнивается `UserRef.id` автора (Cloud — accountId, DC — name). */
export interface MeRef {
  id?: string;
  displayName: string;
}

/** `myself()` источника (Jiraffe API v1 и свой клиент) → `MeRef`. */
export function meRef(me: { accountId?: string; name?: string; displayName: string }): MeRef {
  const id = me.accountId ?? me.name;
  return { ...(id ? { id } : {}), displayName: me.displayName };
}

/** Событие без привязки к конкретному чату (`fromThisChat`/`duringTurn` считаются по сессии вкладки). */
export type TaskChange = Omit<TaskEvent, 'fromThisChat' | 'duringTurn'>;

/** Всё, что известно о задаче после одной загрузки: карточка и полный перечень изменений (все чаты группы читают одно). */
export interface TaskSnapshot {
  card: TaskCard;
  changes: TaskChange[];
}

const ms = (s: unknown): number => {
  if (typeof s !== 'string') return 0;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : 0;
};

const httpUrl = (u: unknown): string => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u.slice(0, 4_000) : '');

/** `5400` → `1h 30m`; меньше минуты — `<1m`. */
export function formatDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60);
  return [h ? `${h}h` : '', m % 60 ? `${m % 60}m` : ''].filter(Boolean).join(' ');
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const attachmentOf = (a: Attachment): TaskAttachment => ({
  id: str(a?.id),
  filename: str(a?.filename),
  size: num(a?.size),
  mimeType: str(a?.mimeType),
  url: httpUrl(a?.contentUrl),
});

/**
 * Загрузка источника → снимок задачи. HTML (описание, комментарии) превращается в текст — свой клиент отдаёт его
 * несанитизированным, Jiraffe — санитизированным, на тексте разницы нет. Сам HTML уходит в карточку как есть (с обрезкой):
 * санитайзер — в webview, один для обоих источников (roadmap 20, решение 5).
 */
export function buildSnapshot(input: {
  instance: { id: string; name: string; baseUrl: string };
  issue: IssueDetail;
  worklogs: readonly Worklog[];
  me: MeRef | undefined;
  /** У источника есть `writer` (кнопки записи во вкладке). Нет — `false`. */
  canWrite?: boolean;
}): TaskSnapshot {
  const { instance, issue, worklogs, me } = input;
  const isMine = (id: unknown): boolean => me?.id !== undefined && typeof id === 'string' && id === me.id;
  const baseUrl = instance.baseUrl.replace(/\/+$/, '');
  const comments: TaskComment[] = arr(issue.comments).map((c) => {
    const html = str(c?.bodyHtml, MAX_HTML);
    return {
      id: str(c?.id),
      author: str(c?.author?.name),
      mine: isMine(c?.author?.id),
      at: ms(c?.created),
      text: clip(htmlToText(html), MAX_COMMENT),
      html,
    };
  });
  const history: TaskHistory[] = arr(issue.history)
    .slice(-MAX_CARD_ROWS)
    .map((h) => ({
      at: ms(h?.created),
      author: str(h?.author?.name),
      items: arr(h?.items).map((it) => ({
        field: str(it?.field, 200),
        from: typeof it?.from === 'string' ? str(it.from) : null,
        to: typeof it?.to === 'string' ? str(it.to) : null,
      })),
    }));
  const worklogRows: TaskWorklog[] = arr(worklogs)
    .slice(-MAX_CARD_ROWS)
    .map((w) => ({
      id: str(w?.id),
      author: str(w?.author?.name),
      mine: isMine(w?.author?.id),
      at: ms(w?.started),
      seconds: num(w?.timeSpentSec),
      comment: str(w?.comment, MAX_COMMENT),
    }));
  const tt: Partial<Record<keyof TaskCard['time'], unknown>> =
    issue.timetracking && typeof issue.timetracking === 'object' ? issue.timetracking : {};
  const time: TaskCard['time'] = {};
  for (const k of ['originalSec', 'remainingSec', 'spentSec'] as const) {
    const v = secs(tt[k]);
    if (v !== undefined) time[k] = v;
  }
  const epicKey = str(issue.epic?.key, 100);
  const epicSummary = str(issue.epic?.summary, 1_000);
  const key = str(issue.key, 100);
  const card: TaskCard = {
    key,
    instanceId: instance.id,
    instanceName: instance.name,
    title: str(issue.summary, 1_000),
    type: str(issue.type),
    status: str(issue.status),
    statusCategory: CATEGORIES.includes(issue.statusCategory) ? issue.statusCategory : 'new',
    ...(issue.assignee ? { assignee: str(issue.assignee.name) } : {}),
    ...(issue.priority ? { priority: str(issue.priority) } : {}),
    url: `${baseUrl}/browse/${encodeURIComponent(key)}`,
    updatedAt: ms(issue.updated),
    description: clip(htmlToText(str(issue.descriptionHtml, 1_000_000)), MAX_DESCRIPTION),
    descriptionHtml: str(issue.descriptionHtml, MAX_HTML),
    ...(issue.reporter ? { reporter: str(issue.reporter.name) } : {}),
    created: ms(issue.created),
    ...(typeof issue.due === 'string' && issue.due ? { due: str(issue.due, 40) } : {}),
    labels: strs(issue.labels),
    components: strs(issue.components),
    fixVersions: arr(issue.fixVersions)
      .map((v) => str(v?.name))
      .filter(Boolean),
    ...(epicKey ? { epic: { key: epicKey, ...(epicSummary ? { summary: epicSummary } : {}) } } : {}),
    time,
    attachments: arr(issue.attachments).map(attachmentOf),
    comments,
    history,
    worklogs: worklogRows,
    canWrite: input.canWrite === true,
  };

  const changes: TaskChange[] = [];
  const seen = new Map<string, number>();
  arr(issue.history).forEach((h) => {
    arr(h?.items).forEach((it, n) => {
      const field = str(it?.field, 200);
      const from = typeof it?.from === 'string' ? str(it.from) : null;
      const to = typeof it?.to === 'string' ? str(it.to) : null;
      // две записи истории в одну секунду дали бы одинаковый id — повтор получает суффикс (порядок записей стабилен)
      const base = `hist:${str(h.created, 40)}:${n}`;
      const dup = seen.get(base) ?? 0;
      seen.set(base, dup + 1);
      changes.push({
        id: dup ? `${base}#${dup}` : base,
        kind: field.toLowerCase() === 'status' ? 'status' : 'field',
        at: ms(h.created),
        author: str(h.author?.name),
        mine: isMine(h.author?.id),
        text: `${field}: ${from ?? '—'} → ${to ?? '—'}`,
        field,
        from,
        to,
      });
    });
  });
  for (const c of comments) {
    changes.push({ id: `comment:${c.id}`, kind: 'comment', at: c.at, author: c.author, mine: c.mine, text: c.text, commentId: c.id });
  }
  for (const w of arr(worklogs)) {
    const comment = str(w?.comment, MAX_COMMENT);
    const spent = formatDuration(num(w?.timeSpentSec));
    changes.push({
      id: `worklog:${str(w?.id)}`,
      kind: 'worklog',
      at: ms(w?.started),
      author: str(w?.author?.name),
      mine: isMine(w?.author?.id),
      text: comment ? `${spent} · ${comment}` : spent,
    });
  }
  return { card, changes };
}

/** Момент внутри одного из ходов (открытый ход — до `now`), с запасом `slack` после конца. */
export function inTurn(at: number, turns: readonly TurnSpan[], now: number, slack: number): boolean {
  return turns.some((t) => at >= t.start && at <= (t.end ?? now) + slack);
}

export interface EventsOptions {
  now: number;
  /** `false` — события не-`mine` не показываются (настройка `agentura.tasks.humanChanges`). По умолчанию `true`. */
  humanChanges?: boolean;
  limit?: number;
}

/**
 * Лента изменений задачи для чата, который вошёл в группу в `openedAt` (0 — с начала, у мигрированных сессий): новые
 * сверху. `fromThisChat` — автор я и время внутри хода сессии (+60 с) — эвристика, не гарантия.
 */
export function eventsSince(
  snap: Pick<TaskSnapshot, 'changes'>,
  openedAt: number,
  turns: readonly TurnSpan[],
  opts: EventsOptions,
): TaskEvent[] {
  const human = opts.humanChanges !== false;
  return snap.changes
    .filter((c) => c.at > openedAt && (human || c.mine))
    .map(
      (c): TaskEvent => ({
        ...c,
        fromThisChat: c.mine && inTurn(c.at, turns, opts.now, FROM_CHAT_SLACK_MS),
        duringTurn: inTurn(c.at, turns, opts.now, 0),
      }),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, opts.limit ?? MAX_EVENTS);
}

/** Журнал ходов вкладки (живые `turn.start` / `turn.result` главного агента); не переживает Reload Window. */
export class TurnLog {
  private spans: TurnSpan[] = [];

  start(at: number): void {
    const last = this.spans[this.spans.length - 1];
    if (last && last.end === undefined) return; // повторный старт внутри хода
    this.spans.push({ start: at });
    if (this.spans.length > 200) this.spans.splice(0, this.spans.length - 200);
  }

  end(at: number): void {
    const last = this.spans[this.spans.length - 1];
    if (last && last.end === undefined) last.end = Math.max(at, last.start);
  }

  clear(): void {
    this.spans = [];
  }

  /** Копия: потребитель не должен менять журнал. */
  turns(): TurnSpan[] {
    return this.spans.map((s) => ({ ...s }));
  }
}
