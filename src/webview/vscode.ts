import type { AgentProvider } from '../agent/types';
import type { TaskTabState } from '../shared/taskTab';
import { postToHost, type FromWebview, type ToWebview, type VsCodeApiLike } from '../protocol';

declare function acquireVsCodeApi(): VsCodeApiLike;

let api: VsCodeApiLike | undefined;

/** `acquireVsCodeApi()` можно вызвать один раз — кэшируем. Вне VS Code (тесты, браузер) — заглушка. */
export function host(): VsCodeApiLike {
  if (!api) {
    api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} };
  }
  return api;
}

/** Показанный чат вкладки задачи (этап 7): им помечается каждое сообщение хосту (`tab`), см. `TabSlots.receive`. */
let tabChat: string | undefined;

export function setTabChat(id: string | undefined): void {
  tabChat = id;
}

export function send(message: FromWebview): void {
  // сообщение, отправленное до того, как webview узнал о переключении чата хостом, не должно уйти новому чату
  postToHost(host(), tabChat === undefined ? message : ({ ...message, tab: tabChat } as unknown as FromWebview));
}

/** Состояние правой панели вкладки чата (широкий режим): свои значения у каждой вкладки. */
export interface PanelState {
  /** Ширина, px. */
  w?: number;
  /** Свёрнута в полосу. */
  off?: boolean;
  /** Активная вкладка панели. */
  tab?: 'changes' | 'git' | 'agents' | 'task';
  /** Вкладка «git»: файлы деревом (иначе списком путей). */
  gitTree?: boolean;
  /** Вкладка «git»: выбранный репозиторий (`root`) в раскладке «выбор сверху». */
  gitRepo?: string;
  /** Вкладка «git»: показывать только файлы, которые правил агент. */
  gitAgent?: boolean;
  /** Охват вкладки «изменения»: вся сессия или последний ход. */
  changes?: 'session' | 'turn';
  /** Вкладка «задача»: карточка или лента изменений (нет — карточка). */
  taskView?: 'card' | 'changes';
  /** Вкладка «задача»: время (мс) самого позднего события, которое человек уже видел; новее — «новое». */
  taskSeen?: number;
  /** Ключ задачи, для которой записано `taskSeen` (другая задача — отсчёт заново). */
  taskSeenKey?: string;
  /** Охват вкладки «агенты» по видам (список охвата не имеет): последний ход или вся сессия. */
  agScope?: Partial<Record<'tree' | 'lanes' | 'cards', 'turn' | 'session'>>;
}

/** Всё, что webview кладёт в `setState`: id сессии (для сериализатора) и панель. Поля независимы. */
export interface WebviewState {
  sessionId?: string;
  /** Движок сессии (`claude` | `codex`): без него сериализатор гадает по памяти воркспейса. */
  provider?: AgentProvider;
  panel?: PanelState;
  /** Боковая панель: свёрнутые секции. */
  fold?: SidebarFold;
  /** Боковая панель: свёрнутые группы задач (ключи групп). */
  taskFold?: string[];
  /** Вкладка настроек: открытый раздел. */
  settingsSection?: SettingsSection;
  /** Вкладка графа агентов: выбранные ход и агент (`sessionId` — сессия, которую граф показывал). */
  graph?: GraphViewState;
  /** Вкладка на задачу (`tasks.tab = task`, roadmap 19, этап 7): её чаты — по ним сериализатор вернёт их все. */
  taskTab?: TaskTabState;
}

/** Выбор во вкладке графа агентов: переживает скрытие вкладки и перезагрузку окна. */
export interface GraphViewState {
  turn?: number;
  selected?: string;
}

/** Разделы вкладки настроек (страницы, порядок в навигации). */
export const SETTINGS_SECTIONS = ['session', 'limits', 'sidebar', 'look', 'integrations', 'engine'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Свёрнутые секции боковой панели (нет поля — развёрнута). */
export interface SidebarFold {
  account?: boolean;
  sessions?: boolean;
  /** Секция «Задачи» (вид `section`). */
  tasks?: boolean;
}

function readState(): WebviewState {
  try {
    const st = host().getState?.();
    return st && typeof st === 'object' ? (st as WebviewState) : {};
  } catch {
    return {};
  }
}

function writeState(state: WebviewState): void {
  try {
    host().setState?.(state);
  } catch {
    // состояние необязательно: без него вкладка откроется пустой, панель — со значениями по умолчанию
  }
}

/** Запомнить id сессии вкладки: по нему сериализатор панели возобновит её после перезагрузки окна. */
export function persistSession(sessionId: string, provider?: AgentProvider): void {
  writeState({ ...readState(), sessionId, ...(provider ? { provider } : {}) });
}

/**
 * Вкладка бросила сессию (новая, `/clear`, сброс хостом): забыть id, иначе после перезагрузки окна
 * сериализатор воскресит брошенную сессию (а она могла быть уже открыта в другой вкладке).
 * Состояние панели остаётся: ширина и вид панели принадлежат вкладке, а не сессии.
 */
export function forgetSession(): void {
  const st = readState();
  // список чатов вкладки задачи принадлежит вкладке (его ведёт хост), а не брошенной сессии
  writeState({ ...(st.panel ? { panel: st.panel } : {}), ...(st.taskTab ? { taskTab: st.taskTab } : {}) });
}

/** Чаты вкладки задачи от хоста (`tab.chats.persist`): сериализатор вернёт их после перезагрузки окна. */
export function saveTaskTab(taskTab: TaskTabState): void {
  writeState({ ...readState(), taskTab });
}

/**
 * Сохранённое состояние панели (пусто — значения по умолчанию). Состояние переживает обновления
 * расширения, поэтому чужие типы полей отбрасываются: кривое поле — как отсутствующее.
 */
export function readPanel(): PanelState {
  const p = readState().panel as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return {};
  const out: PanelState = {};
  if (typeof p.w === 'number' && Number.isFinite(p.w) && p.w > 0) out.w = p.w;
  if (typeof p.off === 'boolean') out.off = p.off;
  // вкладка «ход» стала «изменениями»: сохранённое 'turn' открывает её
  if (p.tab === 'turn' || p.tab === 'changes') out.tab = 'changes';
  else if (p.tab === 'git') out.tab = 'git';
  else if (p.tab === 'agents') out.tab = 'agents';
  else if (p.tab === 'task') out.tab = 'task';
  if (p.taskView === 'card' || p.taskView === 'changes') out.taskView = p.taskView;
  if (typeof p.taskSeen === 'number' && Number.isFinite(p.taskSeen) && p.taskSeen >= 0) out.taskSeen = p.taskSeen;
  if (typeof p.taskSeenKey === 'string' && p.taskSeenKey) out.taskSeenKey = p.taskSeenKey;
  if (typeof p.gitTree === 'boolean') out.gitTree = p.gitTree;
  if (typeof p.gitRepo === 'string' && p.gitRepo) out.gitRepo = p.gitRepo;
  if (typeof p.gitAgent === 'boolean') out.gitAgent = p.gitAgent;
  if (p.changes === 'session' || p.changes === 'turn') out.changes = p.changes;
  const sc = p.agScope as Record<string, unknown> | undefined;
  if (sc && typeof sc === 'object') {
    const agScope: NonNullable<PanelState['agScope']> = {};
    for (const k of ['tree', 'lanes', 'cards'] as const) {
      if (sc[k] === 'turn' || sc[k] === 'session') agScope[k] = sc[k];
    }
    if (Object.keys(agScope).length) out.agScope = agScope;
  }
  return out;
}

/** Дописать поля в состояние панели, не трогая остальное состояние (в том числе `sessionId`). */
export function savePanel(patch: PanelState): void {
  writeState({ ...readState(), panel: { ...readPanel(), ...patch } });
}

/** Свёрнутые секции боковой панели; кривые поля — как отсутствующие. */
export function readFold(): SidebarFold {
  const f = readState().fold as Record<string, unknown> | undefined;
  if (!f || typeof f !== 'object') return {};
  const out: SidebarFold = {};
  if (typeof f.account === 'boolean') out.account = f.account;
  if (typeof f.sessions === 'boolean') out.sessions = f.sessions;
  if (typeof f.tasks === 'boolean') out.tasks = f.tasks;
  return out;
}

/** Потолок запоминаемых свёрнутых групп: ключи пропавших задач не копятся вечно. */
const TASK_FOLD_MAX = 200;

/** Свёрнутые группы задач в боковой панели (ключи `jira:<инстанс>:<KEY>`); переживают перезагрузку вида. */
export function readTaskFold(): string[] {
  const v = readState().taskFold;
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string').slice(0, TASK_FOLD_MAX) : [];
}

export function saveTaskFold(keys: readonly string[]): void {
  writeState({ ...readState(), taskFold: keys.slice(-TASK_FOLD_MAX) });
}

export function saveFold(fold: SidebarFold): void {
  writeState({ ...readState(), fold });
}

/** Открытый раздел настроек; неизвестный (старые id до страниц) — первый. */
export function readSettingsSection(): SettingsSection {
  const v = readState().settingsSection;
  return (SETTINGS_SECTIONS as readonly unknown[]).includes(v) ? (v as SettingsSection) : 'session';
}

export function saveSettingsSection(section: SettingsSection): void {
  writeState({ ...readState(), settingsSection: section });
}

/** Состояние вкладки графа: сессия и выбор; кривые поля — как отсутствующие. */
export function readGraphState(): { sessionId?: string; graph: GraphViewState } {
  const st = readState();
  const g = st.graph as Record<string, unknown> | undefined;
  const graph: GraphViewState = {};
  if (g && typeof g === 'object') {
    if (typeof g.turn === 'number' && Number.isFinite(g.turn)) graph.turn = g.turn;
    if (typeof g.selected === 'string' && g.selected) graph.selected = g.selected;
  }
  return {
    ...(typeof st.sessionId === 'string' && st.sessionId ? { sessionId: st.sessionId } : {}),
    graph,
  };
}

/**
 * Запомнить, что показывает граф: по `sessionId` сериализатор после перезагрузки окна вернёт вкладку к чату
 * той же сессии (пусто — у чата сессии нет, такой граф закрывается).
 */
export function saveGraphState(sessionId: string, graph: GraphViewState): void {
  writeState({ ...(sessionId ? { sessionId } : {}), graph });
}

/** Сообщения от хоста; возвращает отписку. */
export function onHostMessage(handler: (message: ToWebview) => void): () => void {
  const listener = (e: MessageEvent<ToWebview>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
