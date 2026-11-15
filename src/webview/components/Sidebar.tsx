import { SidebarTaskPicker } from './SidebarTaskPicker';
import { signal } from '@preact/signals';
import { Fragment } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import type {
  AccountSummary,
  EngineLimitsSummary,
  LimitWindowSummary,
  SessionSummary,
  TaskGroupSummary,
} from '../../protocol';
import {
  DEFAULT_SESSION_LIST,
  DEFAULT_SIDEBAR_LIMITS,
  DEFAULT_TASK_SIDEBAR,
  nextSessionListMode,
  type SessionListMode,
  type SidebarLimitsMode,
  type TaskSidebarMode,
} from '../../settings';
import { buildEngines, engineSummaryBadge } from '../engineLimitsView';
import { BrandIcon } from './BrandIcon';
import { ui } from '../strings';
import {
  blockEngines,
  ctxLabel,
  displaySessionTitle,
  filterSessions,
  groupByDay,
  pillClass,
  rowClass,
  subLabel,
  mixedProviders,
  taskLayout,
  whenLabel,
  type TaskBlock,
} from '../sessionsView';
import {
  onHostMessage,
  readFold,
  readTaskFold,
  saveFold,
  saveTaskFold,
  send,
  type SidebarFold,
} from '../vscode';
import { EngineLimitsBody } from './EngineLimits';

const windows = signal<LimitWindowSummary[]>([]);
const usage = signal<{ pending: boolean; updatedAt?: number; error?: string }>({ pending: false });
const account = signal<AccountSummary | undefined>(undefined);
/** Лимиты Codex и Antigravity (`engines.limits`); нет — хост ещё не прислал, показывается только Claude. */
const engineLimits = signal<EngineLimitsSummary[] | undefined>(undefined);
/** Движок активной вкладки чата (`sessions.update.currentProvider`). */
const provider = signal<AgentProvider | undefined>(undefined);
/** Вид лимитов при ≥ 2 движках (`agentura.sidebar.limits`). */
const limitsMode = signal<SidebarLimitsMode>(DEFAULT_SIDEBAR_LIMITS);
/** Движки, чьи лимиты не показывать (`agentura.sidebar.limitsHidden`). */
const hiddenEngines = signal<AgentProvider[]>([]);
/** Где задачи Jira (`agentura.tasks.sidebar`): группы в списке или секция над сессиями. */
const tasksMode = signal<TaskSidebarMode>(DEFAULT_TASK_SIDEBAR);
/** Группы задач (`sessions.update.tasks`); нет — групп нет. */
const taskGroups = signal<TaskGroupSummary[]>([]);
/** Свёрнутые группы задач (ключи групп); переживают перезагрузку вида (state webview). */
const taskFold = signal<ReadonlySet<string>>(new Set(readTaskFold()));
const sessions = signal<SessionSummary[]>([]);
const current = signal<string | undefined>(undefined);
const project = signal('');
/**
 * Вид списка (`agentura.sessionList.*`): `data-list`, `data-ctx`, `data-time` на `.sidebar`, вёрстка — в
 * hud.css.
 */
const listMode = signal<SessionListMode>(DEFAULT_SESSION_LIST);
const listCols = signal({ context: true, time: true });
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

function SessionRow({
  s,
  isCurrent,
  now: n,
  ctxCol,
  mixed: _mixed,
  nest,
  tag,
  listMode = 'compact',
}: {
  s: SessionSummary;
  isCurrent: boolean;
  now: number;
  ctxCol: boolean;
  mixed?: boolean;
  /** Чат вложен в группу задачи (вид `groups`): отступ в названии. */
  nest?: boolean;
  /** Метка ключа задачи справа (вид `section`). */
  tag?: string;
  listMode?: SessionListMode;
}) {
  void _mixed;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const isEditing = editing.value === s.id;
  const disp = displaySessionTitle(s);

  useEffect(() => {
    if (isEditing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [isEditing]);

  const cls = `${rowClass(s, isCurrent)}${disp.untitled ? ' untitled' : ''}${nest ? ' nest' : ''}${tag ? ' tagged' : ''}`;

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
        <span class="s-ico">
          <BrandIcon provider={s.provider ?? 'claude'} />
        </span>
        <span class="s-main t">
          <input
            ref={input}
            class="rename rename-inp"
            value={disp.untitled ? '' : s.title}
            placeholder={disp.untitled ? disp.text : ui.sidebar.renameHint}
            data-tip={ui.sidebar.renameHint}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.isComposing || e.keyCode === 229) return;
                finish(true);
              } else if (e.key === 'Escape') {
                finish(false);
              }
            }}
            onBlur={() => finish(true)}
          />
          <small class="s-sub">{ui.sidebar.renameHint}</small>
        </span>
        <span class="s-right">
          <span class="ctx">{ctxLabel(s)}</span>
          <span class="when s-time">{whenLabel(s, n)}</span>
        </span>
      </div>
    );
  }

  const badge =
    s.state === 'live'
      ? 'live'
      : s.state === 'waiting'
        ? 'wait'
        : s.state === 'error' || s.state === 'limit'
          ? 'err'
          : undefined;
  const badgeTitle =
    s.state === 'live'
      ? ui.sidebar.stateTag.live
      : s.state === 'waiting'
        ? ui.sidebar.stateTag.waiting
        : s.state === 'error'
          ? ui.sidebar.stateTag.error
          : s.state === 'limit'
            ? ui.sidebar.stateTag.limit
            : undefined;

  return (
    <button
      class={cls}
      // контекстное меню VS Code (`webview/context`, package.json): «Привязать к задаче…» / «Отвязать от задачи»
      data-vscode-context={JSON.stringify({
        webviewSection: 'session',
        sessionId: s.id,
        sessionBound: !!s.task,
        sessionArchived: !!s.archived,
        preventDefaultContextMenuItems: true,
      })}
      data-tip={`${disp.text}\n${subLabel(s, true, true)}\n${ui.sidebar.renameTitle}`}
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
      <span class="s-ico">
        <BrandIcon provider={s.provider ?? 'claude'} />
        {badge && <i class={`s-badge ${badge}`} title={badgeTitle} />}
      </span>
      <span class="s-main t">
        <span class="s-title">{disp.text}</span>
        <small class="s-sub">{subLabel(s, !ctxCol, false)}</small>
      </span>
      <span class="s-right">
        {tag && (
          <span class="tag" data-tip={s.task?.title}>
            {tag}
          </span>
        )}
        {listMode === 'compact' && s.state === 'waiting' && (
          <span class="s-pill wait">{ui.sidebar.waitPill}</span>
        )}
        <span class="ctx">{ctxLabel(s)}</span>
        <span class="when s-time">{whenLabel(s, n)}</span>
      </span>
    </button>
  );
}

function toggleTaskFold(key: string) {
  const next = new Set(taskFold.value);
  if (!next.delete(key)) next.add(key);
  taskFold.value = next;
  saveTaskFold([...next]);
}

/** «＋» у группы и у карточки задачи: новый чат по задаче (хост — `agentura.chatForTask` с ключом группы). */
function NewTaskChat({ taskKey }: { taskKey: string }) {
  return (
    <button
      type="button"
      class="plus"
      data-tip={ui.sidebar.tasks.newChat}
      aria-label={ui.sidebar.tasks.newChat}
      onClick={(e) => {
        e.stopPropagation(); // не сворачивать группу / не открывать последний чат
        send({ type: 'task.newChat', taskKey });
      }}
    >
      ＋
    </button>
  );
}

function StatusPill({ meta }: { meta: TaskGroupSummary['meta'] }) {
  return meta.status ? <span class={`pill ${pillClass(meta.statusCategory)}`}>{meta.status}</span> : null;
}

/*
 * Заголовок группы и карточка задачи — обычный `div` с сеткой; действие — настоящая кнопка `.hit` вокруг ключа и статуса,
 * её `::before` растянут на весь заголовок (кликабелен он весь, фокус обводит его целиком). «＋» — соседняя кнопка поверх:
 * кнопка, вложенная в `role="button"`, для скринридера пропадает.
 */

/** Вид `groups`: заголовок группы (ключ, статус, число чатов, «＋», название задачи) и вложенные чаты. */
function TaskGroup({
  block,
  open,
  searching,
  isCurrent,
  now: n,
  ctxCol,
  mixed,
  current: cur,
  listMode,
}: {
  block: TaskBlock;
  open: boolean;
  /** Идёт поиск: найденное раскрыто, сворачивание не действует (иначе после очистки группа «сама» свернута). */
  searching: boolean;
  isCurrent: boolean;
  now: number;
  ctxCol: boolean;
  mixed: boolean;
  current: string | undefined;
  listMode: SessionListMode;
}) {
  const { group } = block;
  const L = ui.sidebar.tasks;
  return (
    <div class={isCurrent ? 'tgp sel' : 'tgp'} data-task={group.taskKey}>
      <div class="tg-h" data-tip={L.groupTip(group.meta.key, group.meta.title)}>
        <i class={open ? 'tw open' : 'tw'} />
        <button
          type="button"
          class="kp hit"
          aria-expanded={open}
          aria-label={L.fold(group.meta.key, !open)}
          onClick={() => !searching && toggleTaskFold(group.taskKey)}
        >
          <span class="tkey">{group.meta.key}</span>
          <StatusPill meta={group.meta} />
        </button>
        <span class="cn">{block.rows.length}</span>
        <NewTaskChat taskKey={group.taskKey} />
        <span class="tt">{group.meta.title}</span>
      </div>
      {open &&
        block.rows.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            isCurrent={cur === s.id}
            now={n}
            ctxCol={ctxCol}
            mixed={mixed}
            nest
            listMode={listMode}
          />
        ))}
    </div>
  );
}

/**
 * Вид `section`: карточка задачи — ключ, статус, движки чатов, «＋», название, время последнего чата. Клик — последний чат.
 * Число, движки и последний чат — по всем чатам задачи, не только совпавшим с поиском.
 */
function TaskCard({ block, isCurrent, now: n }: { block: TaskBlock; isCurrent: boolean; now: number }) {
  const { group } = block;
  const last = block.all.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const L = ui.sidebar.tasks;
  return (
    <div
      class={isCurrent ? 'tk sel' : 'tk'}
      data-task={group.taskKey}
      data-tip={`${group.meta.key} · ${group.meta.title}\n${L.openLast(group.meta.key)}`}
    >
      <button
        type="button"
        class="kp hit"
        aria-label={L.openLast(group.meta.key)}
        onClick={() =>
          send({
            type: 'session.resume',
            sessionId: last.id,
            ...(last.provider ? { provider: last.provider } : {}),
          })
        }
      >
        <span class="tkey">{group.meta.key}</span>
        <StatusPill meta={group.meta} />
      </button>
      <span class="ri">
        {blockEngines(block.all).map((e) => (
          <BrandIcon key={e} provider={e} />
        ))}
        {L.chats(block.all.length)}
        <NewTaskChat taskKey={group.taskKey} />
      </span>
      <span class="tt">{group.meta.title}</span>
      <span class="sub">{L.lastChat(whenLabel(last, n))}</span>
    </div>
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
          limitsMode.value = m.limits ?? DEFAULT_SIDEBAR_LIMITS;
          hiddenEngines.value = m.hidden ?? [];
          tasksMode.value = m.tasks ?? DEFAULT_TASK_SIDEBAR;
          listCols.value = { context: m.context, time: m.time };
          break;
        case 'sessions.update':
          sessions.value = m.sessions;
          taskGroups.value = m.tasks ?? [];
          current.value = m.current;
          provider.value = m.currentProvider;
          if (m.project) project.value = m.project;
          now.value = Date.now();
          break;
        default:
          break;
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = (document.activeElement ?? e.target) as HTMLElement | null;
      if (
        el &&
        typeof el.matches === 'function' &&
        (el.matches('input, textarea') ||
          el.isContentEditable ||
          Boolean(el.closest && el.closest('[contenteditable="true"]')))
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        typeof target.matches === 'function' &&
        (target.matches('input, textarea') ||
          target.isContentEditable ||
          Boolean(target.closest && target.closest('[contenteditable="true"]')))
      ) {
        return;
      }
      const inputs = document.querySelectorAll<HTMLInputElement>('.search-wrap input');
      const searchInp = Array.from(inputs).find((inp) => !inp.closest('[inert]'));
      if (searchInp && document.activeElement !== searchInp) {
        e.preventDefault();
        searchInp.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      clearInterval(id);
      off();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <SidebarView
      look={{
        list: listMode.value,
        context: listCols.value.context,
        time: listCols.value.time,
        limits: limitsMode.value,
        hidden: hiddenEngines.value,
        tasks: tasksMode.value,
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
        tasks: taskGroups.value,
      }}
    />
  );
}

/** Вид панели (`agentura.sessionList.*`, `agentura.sidebar.limits`). */
export interface SidebarLook {
  list: SessionListMode;
  context: boolean;
  time: boolean;
  /** Вид лимитов при ≥ 2 движках; нет — по умолчанию. */
  limits?: SidebarLimitsMode;
  /** Движки, чьи лимиты не показывать; нет — все. */
  hidden?: readonly AgentProvider[];
  /** Где задачи Jira; нет — по умолчанию (группы). */
  tasks?: TaskSidebarMode;
}

/** Ключ свёрнутости группы «Без задачи» в `taskFold` (не совпадает ни с одним `jira:<инстанс>:<KEY>`). */
const FREE_FOLD = '-free';
/** Ключ свёрнутости всего блока групп задач в `taskFold`. */
const TASKS_FOLD = '-tasks';
/** Блок «Архив» свёрнут по умолчанию: ключ в `taskFold` значит «раскрыт» (инверсия к остальным ключам). */
const ARCHIVE_OPEN = '-archive-open';

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
  /** Группы задач (`sessions.update.tasks`); нет — групп нет. */
  tasks?: TaskGroupSummary[] | undefined;
}

/**
 * Разметка панели по виду и данным. Живая панель (`Sidebar`) и миниатюры вида во вкладке настроек рисуются
 * одним кодом — превью не расходится с панелью. Поиск и свёрнутые секции — общие сигналы (в превью не трогаются).
 */
export function SidebarView({ look, data }: { look: SidebarLook; data: SidebarData }) {
  const n = data.now;
  const q = query.value;
  // архивные строки живут только в блоке «Архив» внизу; всё остальное считается по активным
  const active = data.sessions.filter((s) => !s.archived);
  const archivedRows = data.sessions.filter((s) => s.archived);
  const shown = filterSessions(active, q);
  const groups = groupByDay(shown, n);
  const mixed = mixedProviders(data.sessions);
  // задачи: есть ли группы вообще (без них список прежний), раскладка под поиск; вид `groups` | `section`
  const tasksView = look.tasks ?? DEFAULT_TASK_SIDEBAR;
  const allTasks = data.tasks?.length ? taskLayout(active, data.tasks, '') : undefined;
  const hasTasks = !!allTasks && allTasks.blocks.length > 0;
  const layout = hasTasks ? (q.trim() ? taskLayout(active, data.tasks, q) : allTasks) : undefined;
  const asGroups = hasTasks && tasksView === 'groups';
  const asSection = hasTasks && tasksView === 'section';
  const folded = taskFold.value;
  const searching = q.trim() !== '';
  const curBlock = (b: TaskBlock) => b.all.some((s) => s.id === data.current);
  const freeOpen = searching || !folded.has(FREE_FOLD);
  const archivedShown = filterSessions(archivedRows, q);
  const archiveOpen = searching || folded.has(ARCHIVE_OPEN);
  const tasksOpen = searching || !folded.has(TASKS_FOLD);
  const f = fold.value;
  const engines = buildEngines(data.windows, data.account, data.engines, n, look.hidden);
  const none = engines.length === 0;
  const variant: SidebarLimitsMode = look.limits ?? DEFAULT_SIDEBAR_LIMITS;
  // блок «Архив» — последний в списке; по умолчанию свёрнут, при поиске раскрыт (и без клика)
  const archiveBlock = archivedShown.length > 0 && (
    <div class="tgp none arch">
      <div class={`tg-h nokey${!archiveOpen && archivedShown.some((s) => s.id === data.current) ? ' sel' : ''}`}>
        <i class={archiveOpen ? 'tw open' : 'tw'} />
        <button
          type="button"
          class="kp hit"
          aria-expanded={archiveOpen}
          onClick={() => !searching && toggleTaskFold(ARCHIVE_OPEN)}
        >
          <b>{ui.sidebar.tasks.archive}</b>
        </button>
        <span class="cn">{archivedShown.length}</span>
      </div>
      {archiveOpen &&
        groupByDay(archivedShown, n).map((g) => (
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
                nest
                listMode={look.list}
              />
            ))}
          </>
        ))}
    </div>
  );
  return (
    <div
      class="sidebar"
      aria-label={ui.sidebar.aria}
      data-list={look.list}
      data-ctx={look.context ? 'on' : 'off'}
      data-time={look.time ? 'on' : 'off'}
      data-tasks={hasTasks ? tasksView : undefined}
    >
      {!none && (
        <section
          class={`sec acc${engines.length >= 2 ? ' multi' : ''}${f.account ? ' folded' : ''}`}
          data-limits={variant}
        >
          <h3 {...foldProps('account', ui.sidebar.limitsTitle)}>
            <span class="tri" />
            {ui.sidebar.limitsTitle}
            {engines.length >= 2 && <span class="sec-meta">{ui.sidebar.engineCount(engines.length)}</span>}
            <span class="sec-summary">
              {engines.map((e, idx) => {
                const b = engineSummaryBadge(e);
                const badgeClass =
                  b.level === 'hot'
                    ? 'hot lim-full'
                    : b.level === 'warn'
                      ? 'warn lim-warn'
                      : b.level === 'err'
                        ? 'err'
                        : undefined;
                return (
                  <Fragment key={e.engine}>
                    {idx > 0 && <span class="sec-sep"> · </span>}
                    <span class={badgeClass}>{b.text}</span>
                  </Fragment>
                );
              })}
            </span>
          </h3>
          <EngineLimitsBody
            variant={variant}
            engines={engines}
            current={data.provider}
          />
        </section>
      )}
      {asSection && layout && layout.blocks.length > 0 && (
        <section class={f.tasks ? 'sec tasks folded' : 'sec tasks'}>
          <h3 {...foldProps('tasks', ui.sidebar.tasks.section)}>
            <span class="tri" />
            {ui.sidebar.tasks.section}
            <span class="count">· {allTasks?.blocks.length}</span>
          </h3>
          {layout.blocks.map((b) => (
            <TaskCard key={b.group.taskKey} block={b} isCurrent={curBlock(b)} now={n} />
          ))}
        </section>
      )}
      <section class={f.sessions ? 'sec folded' : 'sec'}>
        <h3 {...foldProps('sessions', ui.sidebar.sessions)}>
          <span class="tri" />
          {ui.sidebar.sessions}
          <span class="r" style={{ color: 'var(--fg-mute)' }}>
            {data.project}
          </span>
          <SidebarTaskPicker />
          <ListModeButton cur={look.list} />
        </h3>
      </section>
      <div class="search-wrap" hidden={f.sessions}>
        <svg
          class="s-ic"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.6" />
          <path d="m10.5 10.5 3.2 3.2" stroke-linecap="round" />
        </svg>
        <input
          type="search"
          placeholder={hasTasks ? ui.sidebar.tasks.searchWithTasks : ui.sidebar.search}
          aria-label={hasTasks ? ui.sidebar.tasks.searchWithTasks : ui.sidebar.search}
          value={q}
          autoComplete="off"
          onInput={(e) => (query.value = e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (query.value) {
                e.preventDefault();
                query.value = '';
              } else {
                e.currentTarget.blur();
              }
            }
          }}
        />
        {!q && <kbd class="search-kbd">/</kbd>}
        {q ? (
          <button
            type="button"
            class="search-clear"
            data-tip={ui.sidebar.searchClear}
            aria-label={ui.sidebar.searchClear}
            onClick={(e) => {
              query.value = '';
              const inp = e.currentTarget.parentElement?.querySelector<HTMLInputElement>('input');
              inp?.focus();
            }}
          >
            ✕
          </button>
        ) : null}
      </div>
      <div class="list" hidden={f.sessions}>
        {asGroups && layout ? (
          <>
            {layout.blocks.length === 0 && layout.free.length === 0 && archivedShown.length === 0 && (
              <div class="day">{ui.sidebar.noMatches}</div>
            )}
            {layout.blocks.length > 0 && (
              // весь блок задач сворачивается, как «Без задачи»; группы остаются прямыми детьми списка.
              // свёрнут с текущим чатом внутри — заголовок подсвечен
              <div class={`tga tg-h nokey${tasksOpen ? ' open' : ''}${!tasksOpen && layout.blocks.some(curBlock) ? ' sel' : ''}`}>
                <i class={tasksOpen ? 'tw open' : 'tw'} />
                <button
                  type="button"
                  class="kp hit"
                  aria-expanded={tasksOpen}
                  onClick={() => !searching && toggleTaskFold(TASKS_FOLD)}
                >
                  <b>{ui.sidebar.tasks.section}</b>
                </button>
                <span class="cn">{layout.blocks.length}</span>
              </div>
            )}
            {tasksOpen &&
              layout.blocks.map((b) => (
                <TaskGroup
                  key={b.group.taskKey}
                  block={b}
                  // при поиске найденное видно, даже если группа свёрнута
                  open={searching || !folded.has(b.group.taskKey)}
                  searching={searching}
                  isCurrent={curBlock(b)}
                  now={n}
                  ctxCol={look.context}
                  mixed={mixed}
                  current={data.current}
                  listMode={look.list}
                />
              ))}
            {layout.free.length > 0 && (
              <div class="tgp none">
                <div class="tg-h nokey">
                  <i class={freeOpen ? 'tw open' : 'tw'} />
                  {/* имя кнопки — её текст «Без задачи», состояние — aria-expanded */}
                  <button
                    type="button"
                    class="kp hit"
                    aria-expanded={freeOpen}
                    onClick={() => !searching && toggleTaskFold(FREE_FOLD)}
                  >
                    <b>{ui.sidebar.tasks.noTask}</b>
                  </button>
                  <span class="cn">{layout.free.length}</span>
                </div>
                {/* внутри «Без задачи» — прежнее деление по дням (решение владельца 2026-10-08) */}
                {freeOpen &&
                  groupByDay(layout.free, n).map((g) => (
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
                          nest
                          listMode={look.list}
                        />
                      ))}
                    </>
                  ))}
              </div>
            )}
          </>
        ) : (
          <>
            {groups.length === 0 && archivedShown.length === 0 && (
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
                    listMode={look.list}
                    {...(asSection && s.task ? { tag: s.task.key } : {})}
                  />
                ))}
              </>
            ))}
          </>
        )}
        {archiveBlock}
      </div>
    </div>
  );
}
