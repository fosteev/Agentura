/**
 * Настройки Agentura (`agentura.*`): чтение, проверка и запись. Модуль без `vscode` — им пользуются и
 * хост (вкладка настроек, `chatController`), и webview настроек; доступ к конфигурации приходит снаружи.
 * Источник правды — настройки VS Code: вкладка настроек только читает и пишет их.
 */
import type { EffortLevel, PermissionMode } from './agent/types';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Режимы по умолчанию как в настройке: `manual` — обычный режим с подтверждениями. */
export const DEFAULT_MODES = ['manual', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type DefaultMode = (typeof DEFAULT_MODES)[number];

/** Предел автосжатия движка: пороги шкалы должны быть ниже (токены). */
export const CONTEXT_LIMIT = 200_000;
export const MIN_POLL_MINUTES = 5;
/** Сутки: длиннее setTimeout в Node не держит (2^31 мс ≈ 24,8 дня), а реже суток опрос бессмыслен. */
export const MAX_POLL_MINUTES = 1440;
export const DEFAULT_THRESHOLDS: [number, number] = [120_000, 150_000];
/**
 * Вид списка сессий в боковой панели (`sessionList.view`): `detailed` — две строки (название, ходы и цена),
 * `compact` — в одну, кроме текущей, идущей и ждущих ответа, `dense` — все в одну. Подробности — в подсказке.
 * Колонки контекста и времени справа включаются отдельно: `sessionList.context`, `sessionList.time`.
 */
export const SESSION_LIST_MODES = ['detailed', 'compact', 'dense'] as const;
export type SessionListMode = (typeof SESSION_LIST_MODES)[number];
export const DEFAULT_SESSION_LIST: SessionListMode = 'compact';
/**
 * Вид верха боковой панели (`sidebar.top`): `detailed` — аккаунт таблицей, у лимитов шкала и строка сброса;
 * `compact` — аккаунт и каждый лимит в строку, «Новая сессия» — кнопкой ＋ в заголовке «Сессии»;
 * `dense` — секции аккаунта нет, лимиты мини-шкалами в заголовке панели, аккаунт — в подсказке.
 */
export const SIDEBAR_TOP_MODES = ['detailed', 'compact', 'dense'] as const;
export type SidebarTopMode = (typeof SIDEBAR_TOP_MODES)[number];
export const DEFAULT_SIDEBAR_TOP: SidebarTopMode = 'detailed';
/**
 * Вид ленты чата (`feed.style`): `journal` — плоский журнал, как раньше; `folded` — завершённые ходы со свёрнутыми
 * действиями; `replies` — реплики с чипами действий; `cards` — ход карточкой. DOM один, вид — `data-feed` + CSS.
 */
export const FEED_STYLES = ['journal', 'folded', 'replies', 'cards'] as const;
export type FeedStyle = (typeof FEED_STYLES)[number];
export const DEFAULT_FEED_STYLE: FeedStyle = 'journal';
/**
 * Вид вкладки «агенты» правой панели (`agents.view`): `list` — список с деталями, `tree` — дерево сессии, `lanes` —
 * дорожки времени, `cards` — карточки; `graph` — граф во вкладке редактора (панель при нём показывает `list`).
 */
export const AGENTS_VIEWS = ['list', 'tree', 'lanes', 'cards', 'graph'] as const;
export type AgentsView = (typeof AGENTS_VIEWS)[number];
export const DEFAULT_AGENTS_VIEW: AgentsView = 'list';
/**
 * Язык интерфейса (`language`): `auto` — как в VS Code (`vscode.env.language`), иначе явно. Применяется после
 * перезагрузки окна.
 */
export const LANGUAGE_MODES = ['auto', 'ru', 'en'] as const;
export type LanguageMode = (typeof LANGUAGE_MODES)[number];
export const DEFAULT_LANGUAGE: LanguageMode = 'auto';
/**
 * Размер текста ленты (`feed.fontSize`), px: базовый текст ответа. Остальные размеры ленты масштабируются
 * от него (`--fz` в CSS), так что 13 — вёрстка как есть. Те же границы и умолчание — у размера интерфейса (`ui.fontSize`).
 */
export const DEFAULT_FEED_FONT_SIZE = 13;
export const MIN_FEED_FONT_SIZE = 10;
export const MAX_FEED_FONT_SIZE = 20;

/** Ключи без префикса `agentura.` — те же, что в `getConfiguration('agentura')`. */
export type SettingKey =
  | 'defaultPermissionMode'
  | 'allowBypassPermissions'
  | 'defaultModel'
  | 'defaultEffort'
  | 'contextThresholds'
  | 'usagePollMinutes'
  | 'limits.readKeychain'
  | 'claudeExecutable'
  | 'sessionList.view'
  | 'sessionList.context'
  | 'sessionList.time'
  | 'sidebar.top'
  | 'feed.style'
  | 'agents.view'
  | 'feed.fontSize'
  | 'ui.fontSize'
  | 'font.interface'
  | 'font.panels'
  | 'font.code'
  | 'language';

export const SETTING_KEYS: readonly SettingKey[] = [
  'defaultPermissionMode',
  'allowBypassPermissions',
  'defaultModel',
  'defaultEffort',
  'contextThresholds',
  'usagePollMinutes',
  'limits.readKeychain',
  'claudeExecutable',
  'sessionList.view',
  'sessionList.context',
  'sessionList.time',
  'sidebar.top',
  'feed.style',
  'agents.view',
  'feed.fontSize',
  'ui.fontSize',
  'font.interface',
  'font.panels',
  'font.code',
  'language',
];

/**
 * `scope: machine` в package.json: пишутся только в пользовательские настройки машины. Режим по умолчанию —
 * не machine (решение владельца 2026-10-01): его можно задать на проект; bypass из него всё равно требует
 * machine-настройки `allowBypassPermissions`.
 */
export const MACHINE_KEYS: readonly SettingKey[] = ['allowBypassPermissions', 'claudeExecutable'];

export interface SettingsValues {
  defaultPermissionMode: DefaultMode;
  allowBypassPermissions: boolean;
  defaultModel: string;
  /** Пусто — выбор движка. */
  defaultEffort: '' | EffortLevel;
  contextThresholds: [number, number];
  usagePollMinutes: number;
  'limits.readKeychain': boolean;
  claudeExecutable: string;
  'sessionList.view': SessionListMode;
  'sessionList.context': boolean;
  'sessionList.time': boolean;
  'sidebar.top': SidebarTopMode;
  'feed.style': FeedStyle;
  'agents.view': AgentsView;
  'feed.fontSize': number;
  /** Размер интерфейса (всё, кроме ленты), px; 13 — как есть, иначе всё масштабируется (`--ui-zoom`). */
  'ui.fontSize': number;
  /** Пусто — шрифт интерфейса VS Code. */
  'font.interface': string;
  /** Шапка, поле ввода, правая и левая панели; пусто — как было (чат моноширинный, боковая — шрифт интерфейса). */
  'font.panels': string;
  /** Пусто — шрифт редактора VS Code. */
  'font.code': string;
  language: LanguageMode;
}

/** Результат «проверить» у пути к claude: тот же поиск, что при старте движка (`resolveExecutable`). */
export interface EngineCheck {
  ok: boolean;
  path?: string;
  version?: string;
  source: 'setting' | 'system' | 'none';
  problem?: string;
}

/** Минимум от `WorkspaceConfiguration`. */
export interface ConfigLike {
  get<T>(key: string): T | undefined;
  inspect?(key: string): { workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined;
  update(key: string, value: unknown, target: unknown): PromiseLike<void>;
}

export function isDefaultMode(v: unknown): v is DefaultMode {
  return typeof v === 'string' && (DEFAULT_MODES as readonly string[]).includes(v);
}

export function isSessionListMode(v: unknown): v is SessionListMode {
  return typeof v === 'string' && (SESSION_LIST_MODES as readonly string[]).includes(v);
}

export function isSidebarTopMode(v: unknown): v is SidebarTopMode {
  return typeof v === 'string' && (SIDEBAR_TOP_MODES as readonly string[]).includes(v);
}

export function isFeedStyle(v: unknown): v is FeedStyle {
  return typeof v === 'string' && (FEED_STYLES as readonly string[]).includes(v);
}

export function isAgentsView(v: unknown): v is AgentsView {
  return typeof v === 'string' && (AGENTS_VIEWS as readonly string[]).includes(v);
}

export function isFeedFontSize(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_FEED_FONT_SIZE &&
    v <= MAX_FEED_FONT_SIZE
  );
}

export function isLanguageMode(v: unknown): v is LanguageMode {
  return typeof v === 'string' && (LANGUAGE_MODES as readonly string[]).includes(v);
}

/** Язык интерфейса: явный `ru`/`en`, иначе (auto или мусор) — по языку VS Code: `ru*` → русский, остальное → английский. */
export function resolveLanguage(raw: unknown, envLanguage: string): 'ru' | 'en' {
  if (raw === 'ru' || raw === 'en') return raw;
  return envLanguage.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Следующий вид по кнопке в заголовке «Сессии»: подробно → компактно → плотно → подробно. */
export function nextSessionListMode(m: SessionListMode): SessionListMode {
  const i = SESSION_LIST_MODES.indexOf(m);
  return SESSION_LIST_MODES[(i + 1) % SESSION_LIST_MODES.length] ?? DEFAULT_SESSION_LIST;
}

export function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** Режим новой сессии: `manual` → `default`; `bypassPermissions` без разрешения — обычный режим. */
export function resolveDefaultMode(raw: unknown, allowBypass: boolean): PermissionMode {
  if (raw === 'acceptEdits' || raw === 'plan') return raw;
  if (raw === 'bypassPermissions' && allowBypass) return 'bypassPermissions';
  return 'default';
}

/** Effort новой сессии: пусто или мусор — не задавать (решает движок). */
export function resolveDefaultEffort(raw: unknown): EffortLevel | undefined {
  return isEffort(raw) ? raw : undefined;
}

type ErrLang = 'ru' | 'en';

/** Тексты ошибок полей (показываются во вкладке настроек). Свой словарь: файл общий для хоста и webview. */
const ERRORS = {
  ru: {
    twoNumbers: 'Нужны два числа: жёлтый и оранжевый порог.',
    numbers: 'Пороги должны быть числами.',
    integers: 'Пороги — целые числа больше нуля.',
    yellowBelowOrange: 'Жёлтый порог должен быть ниже оранжевого.',
    orangeBelow: (limit: string) => `Оранжевый порог должен быть ниже ${limit} (там автосжатие).`,
    unknownMode: 'Неизвестный режим.',
    allowed: (list: string) => `Допустимо: ${list}.`,
    allowedOrEmpty: (list: string) => `Допустимо: пусто, ${list}.`,
    yesNo: 'Нужно да или нет.',
    string: 'Нужна строка.',
    wholeMinutes: 'Нужно целое число минут.',
    atLeast: (n: number) => `Не меньше ${n}.`,
    atMost: (n: number) => `Не больше ${n} (сутки).`,
    pxRange: (a: number, b: number) => `Нужно целое число от ${a} до ${b}.`,
    fontName: 'Без символов ; { } < >.',
  },
  en: {
    twoNumbers: 'Two numbers are required: the yellow and orange thresholds.',
    numbers: 'Thresholds must be numbers.',
    integers: 'Thresholds must be whole numbers above zero.',
    yellowBelowOrange: 'The yellow threshold must be below the orange one.',
    orangeBelow: (limit: string) =>
      `The orange threshold must be below ${limit} (auto-compact happens there).`,
    unknownMode: 'Unknown mode.',
    allowed: (list: string) => `Allowed: ${list}.`,
    allowedOrEmpty: (list: string) => `Allowed: empty, ${list}.`,
    yesNo: 'Must be yes or no.',
    string: 'A string is required.',
    wholeMinutes: 'A whole number of minutes is required.',
    atLeast: (n: number) => `At least ${n}.`,
    atMost: (n: number) => `At most ${n} (one day).`,
    pxRange: (a: number, b: number) => `A whole number from ${a} to ${b} is required.`,
    fontName: 'No ; { } < > characters.',
  },
} as const;

/** Пороги: жёлтый < оранжевый < 200 000, целые положительные. Текст ошибки — для поля. */
export function thresholdsError(v: unknown, lang: ErrLang = 'ru'): string | undefined {
  const t = ERRORS[lang];
  if (!Array.isArray(v) || v.length !== 2) return t.twoNumbers;
  const [y, o] = v as unknown[];
  if (
    typeof y !== 'number' ||
    typeof o !== 'number' ||
    !Number.isFinite(y) ||
    !Number.isFinite(o)
  ) {
    return t.numbers;
  }
  if (!Number.isInteger(y) || !Number.isInteger(o) || y <= 0) {
    return t.integers;
  }
  if (y >= o) return t.yellowBelowOrange;
  if (o >= CONTEXT_LIMIT) {
    return t.orangeBelow(CONTEXT_LIMIT.toLocaleString(lang));
  }
  return undefined;
}

export type Checked = { ok: true; value: unknown } | { ok: false; error: string };

/** Проверка значения до записи; возвращает приведённое значение (строки обрезаются). */
export function validateSetting(key: SettingKey, value: unknown, lang: ErrLang = 'ru'): Checked {
  const t = ERRORS[lang];
  const bad = (error: string): Checked => ({ ok: false, error });
  switch (key) {
    case 'defaultPermissionMode':
      return isDefaultMode(value) ? { ok: true, value } : bad(t.unknownMode);
    case 'defaultEffort':
      return value === '' || isEffort(value)
        ? { ok: true, value }
        : bad(t.allowedOrEmpty(EFFORT_LEVELS.join(', ')));
    case 'allowBypassPermissions':
    case 'limits.readKeychain':
    case 'sessionList.context':
    case 'sessionList.time':
      return typeof value === 'boolean' ? { ok: true, value } : bad(t.yesNo);
    case 'defaultModel':
    case 'claudeExecutable':
      return typeof value === 'string' ? { ok: true, value: value.trim() } : bad(t.string);
    case 'font.interface':
    case 'font.panels':
    case 'font.code':
      if (typeof value !== 'string') return bad(t.string);
      return /[;{}<>]/.test(value) ? bad(t.fontName) : { ok: true, value: value.trim() };
    case 'feed.fontSize':
    case 'ui.fontSize':
      return isFeedFontSize(value)
        ? { ok: true, value }
        : bad(t.pxRange(MIN_FEED_FONT_SIZE, MAX_FEED_FONT_SIZE));
    case 'usagePollMinutes':
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return bad(t.wholeMinutes);
      }
      if (value < MIN_POLL_MINUTES) return bad(t.atLeast(MIN_POLL_MINUTES));
      return value <= MAX_POLL_MINUTES
        ? { ok: true, value }
        : bad(t.atMost(MAX_POLL_MINUTES));
    case 'sessionList.view':
      return isSessionListMode(value)
        ? { ok: true, value }
        : bad(t.allowed(SESSION_LIST_MODES.join(', ')));
    case 'sidebar.top':
      return isSidebarTopMode(value)
        ? { ok: true, value }
        : bad(t.allowed(SIDEBAR_TOP_MODES.join(', ')));
    case 'feed.style':
      return isFeedStyle(value) ? { ok: true, value } : bad(t.allowed(FEED_STYLES.join(', ')));
    case 'agents.view':
      return isAgentsView(value) ? { ok: true, value } : bad(t.allowed(AGENTS_VIEWS.join(', ')));
    case 'language':
      return isLanguageMode(value)
        ? { ok: true, value }
        : bad(t.allowed(LANGUAGE_MODES.join(', ')));
    case 'contextThresholds': {
      const e = thresholdsError(value, lang);
      return e ? bad(e) : { ok: true, value };
    }
  }
}

/** Текущие значения; мусор из settings.json заменяется значением по умолчанию. */
export function readSettings(cfg: Pick<ConfigLike, 'get'>): SettingsValues {
  const mode = cfg.get<unknown>('defaultPermissionMode');
  const effort = cfg.get<unknown>('defaultEffort');
  const th = cfg.get<unknown>('contextThresholds');
  const poll = cfg.get<unknown>('usagePollMinutes');
  const list = cfg.get<unknown>('sessionList.view');
  const top = cfg.get<unknown>('sidebar.top');
  const feed = cfg.get<unknown>('feed.style');
  const agv = cfg.get<unknown>('agents.view');
  const lang = cfg.get<unknown>('language');
  const fz = cfg.get<unknown>('feed.fontSize');
  const uz = cfg.get<unknown>('ui.fontSize');
  const str = (k: string) => {
    const v = cfg.get<unknown>(k);
    return typeof v === 'string' ? v : '';
  };
  return {
    defaultPermissionMode: isDefaultMode(mode) ? mode : 'manual',
    allowBypassPermissions: cfg.get<unknown>('allowBypassPermissions') === true,
    defaultModel: str('defaultModel'),
    defaultEffort: isEffort(effort) ? effort : '',
    // кривые пороги показываем как есть, если это два числа (ошибку покажет поле); иначе — по умолчанию
    contextThresholds:
      Array.isArray(th) && th.length === 2 && th.every((n) => typeof n === 'number')
        ? [th[0] as number, th[1] as number]
        : [...DEFAULT_THRESHOLDS],
    usagePollMinutes: typeof poll === 'number' && Number.isFinite(poll) ? poll : 15,
    'limits.readKeychain': cfg.get<unknown>('limits.readKeychain') !== false,
    claudeExecutable: str('claudeExecutable'),
    'sessionList.view': isSessionListMode(list) ? list : DEFAULT_SESSION_LIST,
    'sessionList.context': cfg.get<unknown>('sessionList.context') !== false,
    'sessionList.time': cfg.get<unknown>('sessionList.time') !== false,
    'sidebar.top': isSidebarTopMode(top) ? top : DEFAULT_SIDEBAR_TOP,
    'feed.style': isFeedStyle(feed) ? feed : DEFAULT_FEED_STYLE,
    'agents.view': isAgentsView(agv) ? agv : DEFAULT_AGENTS_VIEW,
    'feed.fontSize': isFeedFontSize(fz) ? fz : DEFAULT_FEED_FONT_SIZE,
    'ui.fontSize': isFeedFontSize(uz) ? uz : DEFAULT_FEED_FONT_SIZE,
    'font.interface': str('font.interface'),
    'font.panels': str('font.panels'),
    'font.code': str('font.code'),
    language: isLanguageMode(lang) ? lang : DEFAULT_LANGUAGE,
  };
}

/** Ключи, значение которых перекрыто настройками рабочей области: запись в Global их не изменит. */
export function overriddenKeys(cfg: Pick<ConfigLike, 'inspect'>): SettingKey[] {
  if (!cfg.inspect) return [];
  return SETTING_KEYS.filter((k) => {
    if (MACHINE_KEYS.includes(k)) return false; // machine-настройки рабочей области движок игнорирует
    const i = cfg.inspect!(k);
    return i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined;
  });
}

/**
 * Запись настройки. Всегда в пользовательские настройки (`ConfigurationTarget.Global`, его значение
 * передаёт хост): для `machine`-настроек другого варианта нет, остальные — общие для всех проектов.
 */
export async function writeSetting(
  cfg: ConfigLike,
  key: SettingKey,
  value: unknown,
  globalTarget: unknown,
): Promise<Checked> {
  const checked = validateSetting(key, value);
  if (!checked.ok) return checked;
  await cfg.update(key, checked.value, globalTarget);
  return checked;
}
