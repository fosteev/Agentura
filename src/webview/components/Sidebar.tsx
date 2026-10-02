import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { AccountSummary, LimitWindowSummary, SessionSummary } from '../../protocol';
import {
  DEFAULT_SESSION_LIST,
  DEFAULT_SIDEBAR_TOP,
  nextSessionListMode,
  type SessionListMode,
  type SidebarTopMode,
} from '../../settings';
import { limitLevel } from '../hudView';
import { ui } from '../strings';
import {
  ctxLabel,
  filterSessions,
  groupByDay,
  limitRows,
  rowClass,
  subLabel,
  whenLabel,
} from '../sessionsView';
import { onHostMessage, readFold, saveFold, send, type SidebarFold } from '../vscode';

const windows = signal<LimitWindowSummary[]>([]);
const usage = signal<{ pending: boolean; updatedAt?: number; error?: string }>({ pending: false });
const account = signal<AccountSummary | undefined>(undefined);
const sessions = signal<SessionSummary[]>([]);
const current = signal<string | undefined>(undefined);
const project = signal('');
/**
 * Вид списка (`agentura.sessionList.*`): `data-list`, `data-ctx`, `data-time` на `.sidebar`, вёрстка — в
 * hud.css.
 */
const listMode = signal<SessionListMode>(DEFAULT_SESSION_LIST);
const listCols = signal({ context: true, time: true });
/**
 * Вид верха (`agentura.sidebar.top`): `data-top` на `.sidebar`; элементы чужого вида не рендерятся, вёрстка —
 * в hud.css. Вид «подробно» — разметка как в прототипе sessions.html.
 */
const topMode = signal<SidebarTopMode>(DEFAULT_SIDEBAR_TOP);
/** Секундный/минутный тик: подписи «сейчас», «через 2 ч 08 мин», день в заголовках. */
const now = signal(Date.now());
/** Строка в режиме переименования (двойной клик): id сессии. */
const editing = signal<string | undefined>(undefined);

/** Свёрнутые секции; переживают перезагрузку вида (state webview). */
const fold = signal<SidebarFold>(readFold());
/** Строка поиска по названию — живой фильтр списка. */
const query = signal('');

/** Одиночный клик — возобновить; ждём, не станет ли он двойным (переименование). */
const CLICK_DELAY_MS = 250;

function refreshUsage() {
  if (usage.value.pending) return;
  usage.value = { ...usage.value, pending: true };
  send({ type: 'limits.refresh' });
}

function refreshTitle(): string {
  const u = usage.value;
  if (u.pending) return ui.sidebar.refreshing;
  const parts: string[] = [ui.sidebar.refreshTitle];
  if (u.updatedAt) {
    parts.push(`${ui.sidebar.updatedAt} ${new Date(u.updatedAt).toLocaleTimeString('ru')}`);
  }
  if (u.error) parts.push(`${ui.sidebar.refreshFailed}: ${u.error}`);
  return parts.join(' · ');
}

function accountRows(a: AccountSummary | undefined): [string, string][] {
  const L = ui.sidebar.accountLabels;
  const dash = ui.sidebar.unknown;
  return [
    [L.account, a?.email ?? dash],
    [L.plan, a?.plan ?? dash],
    [L.login, a?.login ?? (a?.error ? `${ui.sidebar.loadError}: ${a.error}` : dash)],
    [L.agent, a?.engine ? `${ui.sidebar.agentName} · ${a.engine}` : ui.sidebar.agentName],
  ];
}

/** Аккаунт одной строкой (вид «компактно»): почта · план · движок; вход и агент — в подсказке. */
function AccountLine({ a }: { a: AccountSummary | undefined }) {
  const rows = accountRows(a);
  const parts = [a?.plan, a?.engine].filter((x): x is string => !!x);
  const ok = !!a?.login && !a.error;
  return (
    <div class="who" title={rows.map(([k, v]) => `${k}: ${v}`).join('\n')}>
      <b>{a?.email ?? ui.sidebar.unknown}</b>
      {parts.map((x) => (
        <span key={x}>· {x}</span>
      ))}
      {ok && <i class="okd" title={ui.sidebar.loginOk} />}
    </div>
  );
}

/** Уровень цвета у лимита: до 70 % — цвет по умолчанию, дальше жёлтый и красный, как у поля ввода. */
function levelClass(percent: number): string {
  const lv = limitLevel(percent);
  return lv === 'lim-hot' ? '' : lv;
}

function SessionRow({ s }: { s: SessionSummary }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const isEditing = editing.value === s.id;
  useEffect(() => {
    if (isEditing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [isEditing]);

  const cls = rowClass(s, current.value === s.id);
  if (isEditing) {
    const finish = (save: boolean) => {
      const title = input.current?.value.trim() ?? '';
      editing.value = undefined;
      if (save && title && title !== s.title) {
        send({ type: 'session.rename', sessionId: s.id, title });
      }
    };
    return (
      <div class={`${cls} editing`}>
        <span class="dot" />
        <span class="t">
          <input
            ref={input}
            class="rename"
            value={s.title}
            title={ui.sidebar.renameHint}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.isComposing) finish(true);
              else if (e.key === 'Escape') finish(false);
            }}
            onBlur={() => finish(true)}
          />
          <small>{ui.sidebar.renameHint}</small>
        </span>
        <span class="ctx">{ctxLabel(s)}</span>
        <span class="when">{whenLabel(s, now.value)}</span>
      </div>
    );
  }
  return (
    <button
      class={cls}
      title={`${s.title}\n${subLabel(s)}\n${ui.sidebar.renameTitle}`}
      onClick={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(
          () => send({ type: 'session.resume', sessionId: s.id }),
          CLICK_DELAY_MS,
        );
      }}
      onDblClick={() => {
        clearTimeout(timer.current);
        editing.value = s.id;
      }}
    >
      <span class="dot" />
      <span class="t">
        {s.title}
        <small>{subLabel(s, !listCols.value.context)}</small>
      </span>
      <span class="ctx">{ctxLabel(s)}</span>
      <span class="when">{whenLabel(s, now.value)}</span>
    </button>
  );
}

function toggleFold(key: keyof SidebarFold) {
  fold.value = { ...fold.value, [key]: !fold.value[key] };
  saveFold(fold.value);
}

/**
 * Заголовок секции сворачивает её целиком; кнопки внутри (↻, вид списка) живут своей жизнью.
 * `.tri` остаётся span — разметка как в прототипе, поворот — в hud.css.
 */
function foldProps(key: keyof SidebarFold, name: string) {
  const folded = !!fold.value[key];
  const toggle = (e: Event) => {
    if ((e.target as Element).closest('button')) return;
    e.preventDefault();
    toggleFold(key);
  };
  return {
    tabIndex: 0,
    'aria-expanded': !folded,
    title: ui.sidebar.fold(name, folded),
    onClick: toggle,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) toggle(e);
    },
  };
}

/** Кнопка вида списка в заголовке «Сессии»: по кругу подробно → компактно → плотно. */
function ListModeButton() {
  const cur = listMode.value;
  const next = nextSessionListMode(cur);
  const L = ui.sidebar.listMode;
  const title = L.title(L.names[cur], L.names[next]);
  return (
    <button
      type="button"
      class="view"
      title={title}
      aria-label={title}
      onClick={() => {
        listMode.value = next; // сразу, не дожидаясь записи настройки; хост пришлёт фактическое
        send({ type: 'settings.set', key: 'sessionList.view', value: next });
      }}
    >
      {L.icons[cur]}
    </button>
  );
}

export function Sidebar() {
  useEffect(() => {
    const id = setInterval(() => (now.value = Date.now()), 30_000);
    const off = onHostMessage((m) => {
      switch (m.type) {
        case 'limits.update':
          // ошибка опроса без окон не стирает прежние проценты
          if (m.windows.length || !m.error) windows.value = m.windows;
          usage.value = { pending: false, updatedAt: m.updatedAt || undefined, error: m.error };
          break;
        case 'account.info':
          account.value = m;
          break;
        case 'sidebar.view':
          listMode.value = m.view;
          topMode.value = m.top ?? DEFAULT_SIDEBAR_TOP;
          listCols.value = { context: m.context, time: m.time };
          break;
        case 'sessions.update':
          sessions.value = m.sessions;
          current.value = m.current;
          if (m.project) project.value = m.project;
          now.value = Date.now();
          break;
        default:
          break;
      }
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, []);

  const u = usage.value;
  const n = now.value;
  const q = query.value;
  const shown = filterSessions(sessions.value, q);
  const groups = groupByDay(shown, n);
  const f = fold.value;
  const limits = limitRows(windows.value, n);
  const top = topMode.value;
  return (
    <div
      class="sidebar"
      aria-label={ui.sidebar.aria}
      data-list={listMode.value}
      data-ctx={listCols.value.context ? 'on' : 'off'}
      data-time={listCols.value.time ? 'on' : 'off'}
      data-top={top}
    >
      <div
        class="head"
        title={
          top === 'dense'
            ? accountRows(account.value)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
            : undefined
        }
      >
        <span>{ui.sidebar.head}</span>
        {top === 'dense' && (
          <span class="hl">
            {limits
              .filter((l) => l.mini)
              .map((l) => (
                <span
                  class={`m ${levelClass(l.percent)}`.trim()}
                  key={l.key}
                  title={[l.label, l.note].filter(Boolean).join(' · ')}
                >
                  {l.mini}
                  <i>
                    <b style={{ width: `${l.percent}%` }} />
                  </i>
                  <span class="n">{l.percent} %</span>
                </span>
              ))}
            <button
              type="button"
              class={u.pending ? 'refresh busy' : 'refresh'}
              title={refreshTitle()}
              aria-label={ui.sidebar.refreshTitle}
              aria-busy={u.pending}
              disabled={u.pending}
              onClick={refreshUsage}
            >
              {ui.sidebar.refresh}
            </button>
          </span>
        )}
        <button
          type="button"
          class="gear"
          title={ui.sidebar.settings}
          aria-label={ui.sidebar.settings}
          onClick={() => send({ type: 'settings.open' })}
        >
          {ui.sidebar.gear}
        </button>
      </div>
      <section class={f.account ? 'sec acc folded' : 'sec acc'}>
        <h3 {...foldProps('account', ui.sidebar.account)}>
          <span class="tri" />
          {ui.sidebar.account}
          <button
            class={u.pending ? 'refresh busy' : 'refresh'}
            title={refreshTitle()}
            aria-label={ui.sidebar.refreshTitle}
            aria-busy={u.pending}
            disabled={u.pending}
            onClick={refreshUsage}
          >
            {ui.sidebar.refresh}
          </button>
        </h3>
        <div class="kv">
          {accountRows(account.value).map(([k, v]) => (
            <>
              <span>{k}</span>
              <b title={v}>{v}</b>
            </>
          ))}
        </div>
        {top === 'compact' && <AccountLine a={account.value} />}
        <div class="lim">
          {limits.map((l) => (
            <div class="row" key={l.key} title={[l.label, l.note].filter(Boolean).join(' · ')}>
              <span>{l.label}</span>
              <span class={l.full ? 'n full' : 'n'}>{l.percent} %</span>
              <span class="bar">
                <i class={l.full ? 'full' : ''} style={{ width: `${l.percent}%` }} />
              </span>
              {l.note && <small>{l.note}</small>}
              {top === 'compact' && l.reset && <em class="rs">{ui.sidebar.resetShort(l.reset)}</em>}
            </div>
          ))}
        </div>
      </section>
      <section class={f.sessions ? 'sec folded' : 'sec'}>
        <h3 {...foldProps('sessions', ui.sidebar.sessions)}>
          <span class="tri" />
          {ui.sidebar.sessions}
          <span class="r" style={{ color: 'var(--fg-mute)' }}>
            {project.value}
          </span>
          {top !== 'detailed' && (
            <button
              type="button"
              class="add"
              title={`${ui.sidebar.newSession} · ${ui.sidebar.newSessionKey}`}
              aria-label={ui.sidebar.newSession}
              onClick={() => send({ type: 'session.new' })}
            >
              ＋
            </button>
          )}
          <ListModeButton />
        </h3>
        {top === 'detailed' && (
          <button class="new" onClick={() => send({ type: 'session.new' })}>
            <span class="plus">＋</span>
            {ui.sidebar.newSession}
            <span style={{ marginLeft: 'auto', color: 'var(--fg-faint)', fontSize: '11px' }}>
              {ui.sidebar.newSessionKey}
            </span>
          </button>
        )}
      </section>
      <div class="tools" hidden={f.sessions}>
        <input
          type="search"
          placeholder={ui.sidebar.search}
          aria-label={ui.sidebar.search}
          value={q}
          onInput={(e) => (query.value = e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query.value) {
              e.preventDefault();
              query.value = '';
            }
          }}
        />
        <button
          type="button"
          title={q ? ui.sidebar.searchClear : ui.sidebar.searchFocus}
          aria-label={q ? ui.sidebar.searchClear : ui.sidebar.searchFocus}
          onClick={(e) => {
            const input = e.currentTarget.previousElementSibling as HTMLInputElement | null;
            if (query.value) query.value = '';
            input?.focus();
          }}
        >
          {q ? '✕' : '⚲'}
        </button>
      </div>
      <div class="list" hidden={f.sessions}>
        {groups.length === 0 && (
          <div class="day">{q.trim() ? ui.sidebar.noMatches : ui.sidebar.noSessions}</div>
        )}
        {groups.map((g) => (
          <>
            <div class="day">{g.day}</div>
            {g.rows.map((s) => (
              <SessionRow key={s.id} s={s} />
            ))}
          </>
        ))}
      </div>
    </div>
  );
}
