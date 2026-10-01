import type { FromWebview, ToWebview } from '../protocol';
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
  checkEngine(path: string): EngineCheck;
  reveal(target: 'ui' | 'json'): void;
  warn(message: string): void;
}

export const BYPASS_NOT_ALLOWED =
  'Сначала включите «Разрешить режим «без разрешений»» (agentura.allowBypassPermissions).';

/** Логика вкладки настроек без `vscode`: приём сообщений webview и выдача текущих значений. */
export class SettingsController {
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
      case 'settings.checkEngine':
        this.deps.post({
          type: 'settings.engine',
          result: this.deps.checkEngine(typeof m.path === 'string' ? m.path : ''),
        });
        break;
      case 'settings.reveal':
        this.deps.reveal(m.target === 'json' ? 'json' : 'ui');
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
    const checked = validateSetting(key, value);
    // «без разрешений» по умолчанию — только когда сам режим разрешён (machine-настройка)
    if (
      checked.ok &&
      key === 'defaultPermissionMode' &&
      checked.value === 'bypassPermissions' &&
      !readSettings(this.deps.config()).allowBypassPermissions
    ) {
      this.deps.post({ type: 'settings.error', key, message: BYPASS_NOT_ALLOWED });
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
      this.deps.post({ type: 'settings.error', key, message: `Не удалось записать: ${message}` });
      return;
    }
    this.pushState();
  }
}
