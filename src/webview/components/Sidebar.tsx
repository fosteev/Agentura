import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { AccountSummary, LimitWindowSummary, SessionSummary } from '../../protocol';
import { ui } from '../strings';
import { groupByDay, limitRows, rowClass, subLabel, whenLabel } from '../sessionsView';
import { onHostMessage, send } from '../vscode';

const windows = signal<LimitWindowSummary[]>([]);
const usage = signal<{ pending: boolean; updatedAt?: number; error?: string }>({ pending: false });
const account = signal<AccountSummary | undefined>(undefined);
const sessions = signal<SessionSummary[]>([]);
const current = signal<string | undefined>(undefined);
const project = signal('');
/** Секундный/минутный тик: подписи «сейчас», «через 2 ч 08 мин», день в заголовках. */
const now = signal(Date.now());
/** Строка в режиме переименования (двойной клик): id сессии. */
const editing = signal<string | undefined>(undefined);

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
        <span class="when">{whenLabel(s, now.value)}</span>
      </div>
    );
  }
  return (
    <button
      class={cls}
      title={ui.sidebar.renameTitle}
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
        <small>{subLabel(s)}</small>
      </span>
      <span class="when">{whenLabel(s, now.value)}</span>
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
  const groups = groupByDay(sessions.value, n);
  const limits = limitRows(windows.value, n);
  return (
    <div class="sidebar" aria-label={ui.sidebar.aria}>
      <div class="head">
        <span>{ui.sidebar.head}</span>
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
      <section class="sec">
        <h3>
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
        <div class="lim">
          {limits.map((l) => (
            <div class="row" key={l.key}>
              <span>{l.label}</span>
              <span class={l.full ? 'n full' : 'n'}>{l.percent} %</span>
              <span class="bar">
                <i class={l.full ? 'full' : ''} style={{ width: `${l.percent}%` }} />
              </span>
              {l.note && <small>{l.note}</small>}
            </div>
          ))}
        </div>
      </section>
      <section class="sec">
        <h3>
          <span class="tri" />
          {ui.sidebar.sessions}
          <span class="r" style={{ color: 'var(--fg-mute)' }}>
            {project.value}
          </span>
        </h3>
        <button class="new" onClick={() => send({ type: 'session.new' })}>
          <span class="plus">＋</span>
          {ui.sidebar.newSession}
          <span style={{ marginLeft: 'auto', color: 'var(--fg-faint)', fontSize: '11px' }}>
            {ui.sidebar.newSessionKey}
          </span>
        </button>
      </section>
      <div class="tools">
        <input type="search" placeholder={ui.sidebar.search} disabled />
        <button title={ui.sidebar.filterTitle}>⚲</button>
      </div>
      <div class="list">
        {groups.length === 0 && <div class="day">{ui.sidebar.noSessions}</div>}
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
