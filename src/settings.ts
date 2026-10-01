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

/** Ключи без префикса `agentura.` — те же, что в `getConfiguration('agentura')`. */
export type SettingKey =
  | 'defaultPermissionMode'
  | 'allowBypassPermissions'
  | 'defaultModel'
  | 'defaultEffort'
  | 'contextThresholds'
  | 'usagePollMinutes'
  | 'limits.readKeychain'
  | 'claudeExecutable';

export const SETTING_KEYS: readonly SettingKey[] = [
  'defaultPermissionMode',
  'allowBypassPermissions',
  'defaultModel',
  'defaultEffort',
  'contextThresholds',
  'usagePollMinutes',
  'limits.readKeychain',
  'claudeExecutable',
];

/**
 * `scope: machine` в package.json: пишутся только в пользовательские настройки машины. Режим по умолчанию —
 * тоже: иначе `.vscode/settings.json` чужого репозитория выставил бы новым сессиям `acceptEdits`.
 */
export const MACHINE_KEYS: readonly SettingKey[] = [
  'defaultPermissionMode',
  'allowBypassPermissions',
  'claudeExecutable',
];

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

/** Пороги: жёлтый < оранжевый < 200 000, целые положительные. Текст ошибки — для поля. */
export function thresholdsError(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length !== 2) return 'Нужны два числа: жёлтый и оранжевый порог.';
  const [y, o] = v as unknown[];
  if (
    typeof y !== 'number' ||
    typeof o !== 'number' ||
    !Number.isFinite(y) ||
    !Number.isFinite(o)
  ) {
    return 'Пороги должны быть числами.';
  }
  if (!Number.isInteger(y) || !Number.isInteger(o) || y <= 0) {
    return 'Пороги — целые числа больше нуля.';
  }
  if (y >= o) return 'Жёлтый порог должен быть ниже оранжевого.';
  if (o >= CONTEXT_LIMIT) {
    return `Оранжевый порог должен быть ниже ${CONTEXT_LIMIT.toLocaleString('ru')} (там автосжатие).`;
  }
  return undefined;
}

export type Checked = { ok: true; value: unknown } | { ok: false; error: string };

/** Проверка значения до записи; возвращает приведённое значение (строки обрезаются). */
export function validateSetting(key: SettingKey, value: unknown): Checked {
  const bad = (error: string): Checked => ({ ok: false, error });
  switch (key) {
    case 'defaultPermissionMode':
      return isDefaultMode(value) ? { ok: true, value } : bad('Неизвестный режим.');
    case 'defaultEffort':
      return value === '' || isEffort(value)
        ? { ok: true, value }
        : bad(`Допустимо: пусто, ${EFFORT_LEVELS.join(', ')}.`);
    case 'allowBypassPermissions':
    case 'limits.readKeychain':
      return typeof value === 'boolean' ? { ok: true, value } : bad('Нужно да или нет.');
    case 'defaultModel':
    case 'claudeExecutable':
      return typeof value === 'string' ? { ok: true, value: value.trim() } : bad('Нужна строка.');
    case 'usagePollMinutes':
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return bad('Нужно целое число минут.');
      }
      if (value < MIN_POLL_MINUTES) return bad(`Не меньше ${MIN_POLL_MINUTES}.`);
      return value <= MAX_POLL_MINUTES
        ? { ok: true, value }
        : bad(`Не больше ${MAX_POLL_MINUTES} (сутки).`);
    case 'contextThresholds': {
      const e = thresholdsError(value);
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
