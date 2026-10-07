import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import type {
  AccountSummary,
  EngineLimitsSummary,
  LimitWindowSummary,
  SessionSummary,
} from '../../protocol';
import {
  DEFAULT_SESSION_LIST,
  DEFAULT_SIDEBAR_LIMITS,
  DEFAULT_SIDEBAR_TOP,
  nextSessionListMode,
  type SessionListMode,
  type SidebarLimitsMode,
  type SidebarTopMode,
} from '../../settings';
import { buildEngines } from '../engineLimitsView';
import { limitLevel } from '../hudView';
import { ui, uiLang } from '../strings';
import {
  ctxLabel,
  filterSessions,
  groupByDay,
  limitRows,
  rowClass,
  subLabel,
  mixedProviders,
  whenLabel,
} from '../sessionsView';
import { onHostMessage, readFold, saveFold, send, type SidebarFold } from '../vscode';
import {
  EngineHeaderLimits,
  EngineLimitsBody,
  EnginePopup,
  engineLimitsTitle,
} from './EngineLimits';

const windows = signal<LimitWindowSummary[]>([]);
const usage = signal<{ pending: boolean; updatedAt?: number; error?: string }>({ pending: false });
const account = signal<AccountSummary | undefined>(undefined);
/** Лимиты Codex и Antigravity (`engines.limits`); нет — хост ещё не прислал, показывается только Claude. */
const engineLimits = signal<EngineLimitsSummary[] | undefined>(undefined);
/** Движок активной вкладки чата (`sessions.update.currentProvider`). */
const provider = signal<AgentProvider | undefined>(undefined);
/** Вид лимитов при ≥ 2 движках (`agentura.sidebar.limits`). */
const limitsMode = signal<SidebarLimitsMode>(DEFAULT_SIDEBAR_LIMITS);
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
    parts.push(`${ui.sidebar.updatedAt} ${new Date(u.updatedAt).toLocaleTimeString(uiLang)}`);
  }
  if (u.error) parts.push(`${ui.sidebar.refreshFailed}: ${u.error}`);
  return parts.join('\n');
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
    <div class="who" data-tip={rows.map(([k, v]) => `${k}: ${v}`).join('\n')}>
      <b>{a?.email ?? ui.sidebar.unknown}</b>
      {parts.map((x) => (
        <span key={x}>· {x}</span>
      ))}
      {ok && <i class="okd" data-tip={ui.sidebar.loginOk} />}
    </div>
  );
}

/** Уровень цвета у лимита: до 70 % — цвет по умолчанию, дальше жёлтый и красный, как у поля ввода. */
function levelClass(percent: number): string {
  const lv = limitLevel(percent);
  return lv === 'lim-hot' ? '' : lv;
}

function SessionRow({
  s,
  isCurrent,
  now: n,
  ctxCol,
  mixed,
}: {
  s: SessionSummary;
  isCurrent: boolean;
  now: number;
  ctxCol: boolean;
  mixed: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const isEditing = editing.value === s.id;
  useEffect(() => {
    if (isEditing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [isEditing]);

  const cls = rowClass(s, isCurrent);
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
            data-tip={ui.sidebar.renameHint}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.isComposing) finish(true);
              else if (e.key === 'Escape') finish(false);
            }}
            onBlur={() => finish(true)}
          />
          <small>{ui.sidebar.renameHint}</small>
        </span>
        <span class="ctx">{ctxLabel(s)}</span>
        <span class="when">{whenLabel(s, n)}</span>
      </div>
    );
  }
  return (
    <button
      class={cls}
      data-tip={`${s.title}\n${subLabel(s, true, mixed)}\n${ui.sidebar.renameTitle}`}
      onClick={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(
          () =>
            send({
              type: 'session.resume',
              sessionId: s.id,
              ...(s.provider ? { provider: s.provider } : {}),
            }),
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
        <small>{subLabel(s, !ctxCol, mixed)}</small>
      </span>
      <span class="ctx">{ctxLabel(s)}</span>
      <span class="when">{whenLabel(s, n)}</span>
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
function ListModeButton({ cur }: { cur: SessionListMode }) {
  const next = nextSessionListMode(cur);
  const L = ui.sidebar.listMode;
  const title = L.title(L.names[cur], L.names[next]);
  return (
    <button
      type="button"
      class="view"
      data-tip={title}
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
        case 'engines.limits':
          engineLimits.value = m.engines;
          break;
        case 'sidebar.view':
          listMode.value = m.view;
          topMode.value = m.top ?? DEFAULT_SIDEBAR_TOP;
          limitsMode.value = m.limits ?? DEFAULT_SIDEBAR_LIMITS;
          listCols.value = { context: m.context, time: m.time };
          break;
        case 'sessions.update':
          sessions.value = m.sessions;
          current.value = m.current;
          provider.value = m.currentProvider;
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

  return (
    <SidebarView
      look={{
        top: topMode.value,
        list: listMode.value,
        context: listCols.value.context,
        time: listCols.value.time,
        limits: limitsMode.value,
      }}
      data={{
        windows: windows.value,
        account: account.value,
        sessions: sessions.value,
        current: current.value,
        project: project.value,
        now: now.value,
        engines: engineLimits.value,
        provider: provider.value,
      }}
    />
  );
}

/** Вид панели (`agentura.sidebar.top`, `agentura.sessionList.*`). */
export interface SidebarLook {
  top: SidebarTopMode;
  list: SessionListMode;
  context: boolean;
  time: boolean;
  /** Вид лимитов при ≥ 2 движках; нет — по умолчанию. */
  limits?: SidebarLimitsMode;
}

/** Данные панели: живые — из сообщений хоста, в превью настроек — фикстура. */
export interface SidebarData {
  windows: LimitWindowSummary[];
  account: AccountSummary | undefined;
  sessions: SessionSummary[];
  current: string | undefined;
  project: string;
  now: number;
  /** Лимиты Codex и Antigravity; нет — одни Claude (прежняя разметка). */
  engines?: EngineLimitsSummary[] | undefined;
  /** Движок активной вкладки. */
  provider?: AgentProvider | undefined;
}

/**
 * Разметка панели по виду и данным. Живая панель (`Sidebar`) и миниатюры вида во вкладке настроек рисуются
 * одним кодом — превью не расходится с панелью. Поиск и свёрнутые секции — общие сигналы (в превью не трогаются).
 */
export function SidebarView({ look, data }: { look: SidebarLook; data: SidebarData }) {
  const u = usage.value;
  const n = data.now;
  const q = query.value;
  const shown = filterSessions(data.sessions, q);
  const groups = groupByDay(shown, n);
  const mixed = mixedProviders(data.sessions);
  const f = fold.value;
  const limits = limitRows(data.windows, n);
  const top = look.top;
  // установленных движков ≥ 2 → вариант из настройки (`dense` — всегда в заголовке); иначе прежняя разметка
  const engines = buildEngines(data.windows, data.account, data.engines, n);
  const multi = engines.length >= 2;
  const variant: SidebarLimitsMode =
    top === 'dense' ? 'header' : (look.limits ?? DEFAULT_SIDEBAR_LIMITS);
  const inHeader = multi && variant === 'header';
  const refresh = { pending: u.pending, title: refreshTitle(), onClick: refreshUsage };
  return (
    <div
      class="sidebar"
      aria-label={ui.sidebar.aria}
      data-list={look.list}
      data-ctx={look.context ? 'on' : 'off'}
      data-time={look.time ? 'on' : 'off'}
      data-top={top}
    >
      <div
        class="head"
        data-tip={
          top === 'dense' && !multi
            ? accountRows(data.account)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
            : undefined
        }
      >
        <span>{ui.sidebar.head}</span>
        {inHeader && <EngineHeaderLimits engines={engines} refresh={refresh} />}
        {top === 'dense' && !multi && (
          <span class="hl">
            {limits
              .filter((l) => l.mini)
              .map((l) => (
                <span
                  class={`m ${levelClass(l.percent)}`.trim()}
                  key={l.key}
                  data-tip={[l.label, l.note].filter(Boolean).join(' · ')}
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
              data-tip={refreshTitle()}
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
          data-tip={ui.sidebar.settings}
          aria-label={ui.sidebar.settings}
          onClick={() => send({ type: 'settings.open' })}
        >
          {ui.sidebar.gear}
        </button>
      </div>
      {inHeader && <EnginePopup engines={engines} />}
      {!inHeader && (
        <section
          class={`sec acc${multi ? ' multi' : ''}${f.account ? ' folded' : ''}`}
          data-limits={multi ? variant : undefined}
        >
          <h3 {...foldProps('account', multi ? engineLimitsTitle(variant) : ui.sidebar.account)}>
            <span class="tri" />
            {multi ? engineLimitsTitle(variant) : ui.sidebar.account}
            <button
              class={u.pending ? 'refresh busy' : 'refresh'}
              data-tip={refreshTitle()}
              aria-label={ui.sidebar.refreshTitle}
              aria-busy={u.pending}
              disabled={u.pending}
              onClick={refreshUsage}
            >
              {ui.sidebar.refresh}
            </button>
          </h3>
          {multi ? (
            <EngineLimitsBody
              variant={variant as Exclude<SidebarLimitsMode, 'header'>}
              engines={engines}
              current={data.provider}
            />
          ) : (
            <>
              <div class="kv">
                {accountRows(data.account).map(([k, v]) => (
                  <>
                    <span>{k}</span>
                    <b data-tip={v}>{v}</b>
                  </>
                ))}
              </div>
              {top === 'compact' && <AccountLine a={data.account} />}
              <div class="lim">
                {limits.map((l) => (
                  <div
                    class="row"
                    key={l.key}
                    data-tip={[l.label, l.note].filter(Boolean).join(' · ')}
                  >
                    <span>{l.label}</span>
                    <span class={l.full ? 'n full' : 'n'}>{l.percent} %</span>
                    <span class="bar">
                      <i class={l.full ? 'full' : ''} style={{ width: `${l.percent}%` }} />
                    </span>
                    {l.note && <small>{l.note}</small>}
                    {top === 'compact' && l.reset && (
                      <em class="rs">{ui.sidebar.resetShort(l.reset)}</em>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      <section class={f.sessions ? 'sec folded' : 'sec'}>
        <h3 {...foldProps('sessions', ui.sidebar.sessions)}>
          <span class="tri" />
          {ui.sidebar.sessions}
          <span class="r" style={{ color: 'var(--fg-mute)' }}>
            {data.project}
          </span>
          {top !== 'detailed' && (
            <button
              type="button"
              class="add"
              data-tip={ui.sidebar.newSession}
              data-tip-key={ui.sidebar.newSessionKey}
              aria-label={ui.sidebar.newSession}
              onClick={() => send({ type: 'session.new' })}
            >
              ＋
            </button>
          )}
          <ListModeButton cur={look.list} />
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
          data-tip={q ? ui.sidebar.searchClear : ui.sidebar.searchFocus}
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
              <SessionRow
                key={s.id}
                s={s}
                isCurrent={data.current === s.id}
                now={n}
                ctxCol={look.context}
                mixed={mixed}
              />
            ))}
          </>
        ))}
      </div>
    </div>
  );
}
