import type { FromWebview, ToWebview } from '../protocol';
import { hostStrings, type Lang } from '../shared/l10n';
import {
  SETTING_KEYS,
  overriddenKeys,
  readSettings,
  validateSetting,
  writeSetting,
  type ConfigLike,
  type EngineCheck,
  type SettingKey,
} from '../settings';

export interface SettingsDeps {
  /** Свежая конфигурация `agentura` (читается при каждом обращении). */
  config(): ConfigLike;
  /** `ConfigurationTarget.Global`. */
  globalTarget: unknown;
  post(m: ToWebview): void;
  /** Тот же поиск, что при старте движка (`resolveExecutable`). */
  checkEngine(path: string, engine?: 'claude' | 'antigravity'): Promise<EngineCheck>;
  reveal(target: 'ui' | 'json'): void;
  warn(message: string): void;
  /** Скачать шрифт из Google Fonts (`kind` — назначение карточки) / удалить скачанный. */
  addFont?(kind: 'ui' | 'code' | 'panels'): void;
  removeFont?(family: string): void;
  /** Язык текстов ошибок; по умолчанию русский. */
  lang?(): Lang;
}

export const BYPASS_NOT_ALLOWED = hostStrings('ru').bypassNotAllowed;

/** Логика вкладки настроек без `vscode`: приём сообщений webview и выдача текущих значений. */
export class SettingsController {
  /** Номер последней «проверить» — ответ приходит только на неё. */
  private checkSeq = 0;

  constructor(private readonly deps: SettingsDeps) {}

  /** Текущие значения → webview. Зовётся на `ready`, после записи и из `onDidChangeConfiguration`. */
  pushState(): void {
    const cfg = this.deps.config();
    this.deps.post({
      type: 'settings.state',
      values: readSettings(cfg),
      overridden: overriddenKeys(cfg),
    });
  }

  async handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.pushState();
        break;
      case 'settings.set':
        await this.set(m.key, m.value);
        break;
      case 'settings.checkEngine': {
        // проверки асинхронные (до 5 с): ответ устаревшей не должен перебить ответ последней
        const seq = ++this.checkSeq;
        const engine = m.engine === 'antigravity' ? 'antigravity' : 'claude';
        // исключение проверки не должно оставить кнопки «проверить» заблокированными (pending общий на обе строки)
        const result: EngineCheck = await this.deps
          .checkEngine(typeof m.path === 'string' ? m.path : '', engine)
          .catch((e: unknown) => ({ ok: false, source: 'none' as const, problem: String(e) }));
        if (seq === this.checkSeq) this.deps.post({ type: 'settings.engine', result, ...(engine === 'antigravity' ? { engine } : {}) });
        break;
      }
      case 'settings.reveal':
        this.deps.reveal(m.target === 'json' ? 'json' : 'ui');
        break;
      case 'fonts.add':
        this.deps.addFont?.(m.kind === 'code' || m.kind === 'panels' ? m.kind : 'ui');
        break;
      case 'fonts.remove':
        if (typeof m.family === 'string') this.deps.removeFont?.(m.family);
        break;
      default:
        break;
    }
  }

  private async set(key: SettingKey, value: unknown): Promise<void> {
    // ключ приходит из webview: только известные настройки Agentura
    if (!SETTING_KEYS.includes(key)) {
      this.deps.warn(`settings.set: неизвестный ключ ${String(key)}`);
      return;
    }
    const lang = this.deps.lang?.() ?? 'ru';
    const t = hostStrings(lang);
    const checked = validateSetting(key, value, lang);
    // «без разрешений» по умолчанию — только когда сам режим разрешён (machine-настройка)
    if (
      checked.ok &&
      key === 'defaultPermissionMode' &&
      checked.value === 'bypassPermissions' &&
      !readSettings(this.deps.config()).allowBypassPermissions
    ) {
      this.deps.post({ type: 'settings.error', key, message: t.bypassNotAllowed });
      return;
    }
    if (!checked.ok) {
      this.deps.post({ type: 'settings.error', key, message: checked.error });
      return;
    }
    try {
      await writeSetting(this.deps.config(), key, checked.value, this.deps.globalTarget);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.warn(`не удалось записать agentura.${key}: ${message}`);
      this.deps.post({ type: 'settings.error', key, message: t.writeFailed(message) });
      return;
    }
    this.pushState();
  }
}
