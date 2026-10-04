import type { ComponentChildren } from 'preact';
import type { FeedRow } from '../chatState';
import type { SessionSummary } from '../../protocol';
import type { FeedStyle } from '../../settings';
import { uiLang } from '../strings';
import { Log } from './Log';
import { SidebarView, type SidebarData, type SidebarLook } from './Sidebar';

/**
 * Миниатюры вида во вкладке настроек: настоящие `Log` и `SidebarView` на фикстуре, уменьшенные CSS-`zoom`.
 * Вёрстка та же, что у ленты и панели, поэтому превью не расходится с ними. Все превью `inert` — только картинка.
 */

const CWD = '/repo';
const noop = () => {};

const TEXT = {
  ru: {
    ask: 'Почини мигание счётчика талонов на табло',
    think: 'табло сбрасывает состояние при новом соединении',
    reply:
      'Причина — `Counter` сбрасывал счётчик при каждом переподключении сокета. Убрал сброс: значение держится до нового снимка, тесты проходят.',
    sessions: [
      'мигание счётчика талонов',
      'плашка «нет связи» на табло',
      'почему падает lint в ws-client',
      'ретраи запросов к сервису очереди',
      'миграция табло на новый ws-client',
    ],
    account: { email: 'you@example.com', plan: 'Max 5×', login: 'через CLI · ок' },
  },
  en: {
    ask: 'Fix the ticket counter flicker on the board',
    think: 'the board resets its state on a new connection',
    reply:
      'The cause: `Counter` reset the count on every socket reconnect. Removed the reset: the value holds until the next snapshot, tests pass.',
    sessions: [
      'ticket counter flicker',
      '“no connection” banner on the board',
      'why lint fails in ws-client',
      'retries for queue service requests',
      'move the board to the new ws-client',
    ],
    account: { email: 'you@example.com', plan: 'Max 5×', login: 'CLI · ok' },
  },
}[uiLang];

/** Один завершённый ход: запрос, раздумье, чтение, правка, тесты, ответ, итог. */
function feedRows(now: number): FeedRow[] {
  const t = now - 60_000;
  const file = `${CWD}/apps/board/src/Counter.tsx`;
  return [
    { id: 1, kind: 'user', text: TEXT.ask, at: '14:41' },
    { id: 2, kind: 'think', messageId: 'm1', text: TEXT.think, startedAt: t, endedAt: t + 12_000 },
    {
      id: 3,
      kind: 'tool',
      toolUseId: 't1',
      name: 'Read',
      input: { file_path: file },
      startedAt: t + 12_000,
      state: 'ok',
      durationMs: 300,
    },
    {
      id: 4,
      kind: 'tool',
      toolUseId: 't2',
      name: 'Edit',
      input: { file_path: file, old_string: 'a\nb', new_string: 'a\nb\nc\nd\ne\nf' },
      startedAt: t + 14_000,
      state: 'ok',
      durationMs: 1_100,
    },
    {
      id: 5,
      kind: 'tool',
      toolUseId: 't3',
      name: 'Bash',
      input: { command: 'pnpm test --filter board' },
      startedAt: t + 16_000,
      state: 'ok',
      durationMs: 9_800,
    },
    { id: 6, kind: 'text', messageId: 'm2', text: TEXT.reply, streaming: false },
    { id: 7, kind: 'sum', parts: ['in 1 204', 'out 2 318'], cost: '$0.21', time: '48s' },
  ];
}

function sidebarData(now: number): SidebarData {
  const min = 60_000;
  const states: SessionSummary['state'][] = ['live', 'waiting', 'idle', 'idle', 'idle'];
  const ago = [0, 96 * min, 3 * 60 * min, 4 * 60 * min, 26 * 60 * min];
  const ctx = [131_000, 44_000, 12_000, 27_000, 168_000];
  const sessions = TEXT.sessions.map((title, i): SessionSummary => ({
    id: `s${i}`,
    title,
    turns: [14, 3, 2, 7, 31][i] ?? 1,
    costUsd: [1.84, 0.42, 0.11, 0.93, 6.2][i] ?? 0,
    state: states[i] ?? 'idle',
    updatedAt: now - (ago[i] ?? 0),
    contextTokens: ctx[i] ?? 0,
  }));
  return {
    windows: [
      { kind: 'five-hour', percent: 62, resetsAt: now + 128 * min },
      { kind: 'weekly', percent: 34, resetsAt: now + 3 * 24 * 60 * min },
    ],
    account: { ...TEXT.account, engine: 'claude 2.1.285' },
    sessions,
    current: 's0',
    project: 'queue-board',
    now,
  };
}

/** Лента в виде `style`; `scaled` — размер текста из настройки (`--feed-zoom`), иначе масштаб карточки. */
export function FeedPreview({ style, scaled }: { style: FeedStyle; scaled?: boolean }) {
  const now = Date.now();
  return (
    <div class={scaled ? 'pv pv-feed pv-sized' : 'pv pv-feed'} inert aria-hidden="true">
      <div class="webview" data-feed={style}>
        <Log
          rows={feedRows(now)}
          cwd={CWD}
          now={now}
          showThinking
          mode=""
          onDiff={noop}
          onPreview={noop}
          onOpenUrl={noop}
        />
      </div>
    </div>
  );
}

/** Боковая панель: `part="top"` — верх (аккаунт, лимиты), `"list"` — заголовок «Сессии» и список. */
export function SidebarPreview({ look, part }: { look: SidebarLook; part: 'top' | 'list' }) {
  return (
    <div class={`pv pv-side pv-${part}`} inert aria-hidden="true">
      <SidebarView look={look} data={sidebarData(Date.now())} />
    </div>
  );
}

/** Выбор вида карточками-миниатюрами (`role="radiogroup"`): клик выбирает, стрелки — как у радиокнопок. */
export function ChoiceCards<V extends string>({
  label,
  value,
  options,
  preview,
  onPick,
  onTry,
  kind,
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  preview: (v: V) => ComponentChildren;
  onPick: (v: V) => void;
  /** Примерка: наведение или фокус на карточке (`undefined` — ушли). */
  onTry?: (v: V | undefined) => void;
  /** Модификатор сетки: `fonts` — плотные карточки шрифтов. */
  kind?: string;
}) {
  const ids = options.map(([v]) => v);
  const onKey = (e: KeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = ids[(ids.indexOf(value) + step + ids.length) % ids.length];
    if (next === undefined) return;
    onPick(next);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div
      class={kind ? `cards ${kind}` : 'cards'}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      onMouseLeave={() => onTry?.(undefined)}
      onFocusOut={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null))
          onTry?.(undefined);
      }}
    >
      {options.map(([v, name]) => (
        <button
          key={v}
          type="button"
          role="radio"
          data-value={v}
          aria-checked={v === value}
          tabIndex={v === value ? 0 : -1}
          class={v === value ? 'card on' : 'card'}
          onClick={() => v !== value && onPick(v)}
          onMouseEnter={() => onTry?.(v)}
          onFocus={() => onTry?.(v)}
        >
          {preview(v)}
          <span class="cn">{name}</span>
        </button>
      ))}
    </div>
  );
}
