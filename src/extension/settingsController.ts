import type { AgentProvider, ModelOption } from '../agent/types';
import type { IntegrationsState } from '../shared/integrations';
import type { FromWebview, SettingsSection, ToWebview } from '../protocol';
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
  checkEngine(path: string, engine: AgentProvider): Promise<EngineCheck>;
  listCodexModels?(): Promise<ModelOption[]>;
  listAntigravityModels?(): Promise<ModelOption[]>;
  reveal(target: 'ui' | 'json'): void;
  warn(message: string): void;
  /** Скачать шрифт из Google Fonts (`kind` — назначение карточки) / удалить скачанный. */
  addFont?(kind: 'ui' | 'code' | 'panels'): void;
  removeFont?(family: string): void;
  /** Страница «Интеграции» (roadmap 19, этап 6); нет — страница не получает данных. */
  integrations?: {
    state(): IntegrationsState;
    connect(): void;
    test(instanceId: string): void;
    disconnect(instanceId: string): void;
    installJiraffe(): void;
  };
  /** Язык текстов ошибок; по умолчанию русский. */
  lang?(): Lang;
}

export const BYPASS_NOT_ALLOWED = hostStrings('ru').bypassNotAllowed;

/** Логика вкладки настроек без `vscode`: приём сообщений webview и выдача текущих значений. */
export class SettingsController {
  private models: ModelOption[] = [];
  private modelsSeq = 0;
  private modelsPath: string | undefined;
  private agyModels: ModelOption[] = [];
  private agyModelsSeq = 0;
  private agyModelsPath: string | undefined;
  /** Номер последней «проверить» — ответ приходит только на неё. */
  private checkSeq: Record<AgentProvider, number> = { claude: 0, codex: 0, antigravity: 0, cursor: 0 };

  /** Webview прислал `ready` и получил первое состояние: раздел можно слать сразу. */
  private ready = false;
  /** Раздел, запрошенный до `ready` (панель только создана): уходит сразу после первого `settings.state`. */
  private pendingSection: SettingsSection | undefined;

  constructor(private readonly deps: SettingsDeps) {}

  /** Открыть вкладку на разделе: webview уже готов — сразу, иначе после первого состояния. */
  showSection(section: SettingsSection): void {
    if (this.ready) this.deps.post({ type: 'settings.section', section });
    else this.pendingSection = section;
  }

  /** Текущие значения → webview. Зовётся на `ready`, после записи и из `onDidChangeConfiguration`. */
  pushState(): void {
    const cfg = this.deps.config();
    this.deps.post({
      type: 'settings.state',
      values: readSettings(cfg),
      overridden: overriddenKeys(cfg),
    });
    this.pushIntegrations();
    const path = cfg.get<string>('codexExecutable') ?? '';
    if (this.deps.listCodexModels && this.modelsPath !== path) void this.loadCodexModels();
    const agyPath = cfg.get<string>('antigravityExecutable') ?? '';
    if (this.deps.listAntigravityModels && this.agyModelsPath !== agyPath) void this.loadAntigravityModels();
  }

  private async loadCodexModels(): Promise<void> {
    if (!this.deps.listCodexModels) return;
    this.modelsPath = this.deps.config().get<string>('codexExecutable') ?? '';
    const seq = ++this.modelsSeq;
    this.deps.post({ type: 'settings.codexModels', models: this.models, loading: true });
    try {
      const models = await this.deps.listCodexModels();
      if (seq !== this.modelsSeq) return;
      this.models = models;
      this.deps.post({ type: 'settings.codexModels', models, loading: false });
    } catch (e) {
      if (seq !== this.modelsSeq) return;
      this.models = [];
      this.deps.post({ type: 'settings.codexModels', models: [], loading: false, error: String(e) });
    }
  }

  private async loadAntigravityModels(): Promise<void> {
    if (!this.deps.listAntigravityModels) return;
    this.agyModelsPath = this.deps.config().get<string>('antigravityExecutable') ?? '';
    const seq = ++this.agyModelsSeq;
    this.deps.post({ type: 'settings.antigravityModels', models: this.agyModels, loading: true });
    try {
      const models = await this.deps.listAntigravityModels();
      if (seq !== this.agyModelsSeq) return;
      this.agyModels = models;
      this.deps.post({ type: 'settings.antigravityModels', models, loading: false });
    } catch (e) {
      if (seq !== this.agyModelsSeq) return;
      this.agyModels = [];
      this.deps.post({ type: 'settings.antigravityModels', models: [], loading: false, error: String(e) });
    }
  }

  /** Состояние Jiraffe и своих подключений → webview (на `ready`, при смене источников/подключений и настройки). */
  pushIntegrations(): void {
    const i = this.deps.integrations;
    if (i) this.deps.post({ type: 'integrations.state', state: i.state() });
  }

  /**
   * id из webview — только одно из своих подключений: команды этапа 2 на незнакомый id не отказывают, а берут
   * единственное подключение или спрашивают выбор — чужой id не должен дойти до «удалить» не того инстанса.
   */
  private ownInstance(id: unknown): id is string {
    const i = this.deps.integrations;
    return !!i && typeof id === 'string' && i.state().own.some((o) => o.id === id);
  }

  async handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'settings.codexModels':
        await this.loadCodexModels();
        break;
      case 'settings.antigravityModels':
        await this.loadAntigravityModels();
        break;
      case 'ready':
        this.pushState();
        this.ready = true;
        if (this.pendingSection) {
          this.deps.post({ type: 'settings.section', section: this.pendingSection });
          this.pendingSection = undefined;
        }
        break;
      case 'settings.set':
        await this.set(m.key, m.value);
        break;
      case 'settings.checkEngine': {
        // проверки асинхронные (до 5 с): ответ устаревшей не должен перебить ответ последней
        const engine: AgentProvider =
          m.engine === 'codex' || m.engine === 'antigravity' || m.engine === 'cursor' ? m.engine : 'claude';
        const seq = ++this.checkSeq[engine];
        // исключение проверки не должно оставить кнопки «проверить» заблокированными
        const result: EngineCheck = await this.deps
          .checkEngine(typeof m.path === 'string' ? m.path : '', engine)
          .catch((e: unknown) => ({ ok: false, source: 'none' as const, problem: String(e) }));
        if (seq === this.checkSeq[engine])
          this.deps.post({ type: 'settings.engine', result, ...(engine === 'claude' ? {} : { engine }) });
        break;
      }
      case 'settings.reveal':
        this.deps.reveal(m.target === 'json' ? 'json' : 'ui');
        break;
      case 'integrations.connect':
        this.deps.integrations?.connect();
        break;
      case 'integrations.test':
        if (this.ownInstance(m.instanceId)) this.deps.integrations?.test(m.instanceId);
        break;
      case 'integrations.disconnect':
        if (this.ownInstance(m.instanceId)) this.deps.integrations?.disconnect(m.instanceId);
        break;
      case 'integrations.installJiraffe':
        this.deps.integrations?.installJiraffe();
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
      ((key === 'defaultPermissionMode' && checked.value === 'bypassPermissions') ||
        (key === 'codex.defaultSandbox' && checked.value === 'dangerFullAccess')) &&
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
      if (key === 'codex.defaultModel') {
        const effort = readSettings(this.deps.config())['codex.defaultEffort'];
        const levels = this.models.find((m) => m.value === checked.value)?.effortLevels ?? [];
        if (effort && !levels.includes(effort))
          await writeSetting(this.deps.config(), 'codex.defaultEffort', '', this.deps.globalTarget);
      } else if (key === 'antigravity.defaultModel') {
        const effort = readSettings(this.deps.config())['antigravity.defaultEffort'];
        const levels = this.agyModels.find((m) => m.value === checked.value)?.effortLevels ?? [];
        if (effort && !levels.includes(effort))
          await writeSetting(this.deps.config(), 'antigravity.defaultEffort', '', this.deps.globalTarget);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.warn(`не удалось записать agentura.${key}: ${message}`);
      this.deps.post({ type: 'settings.error', key, message: t.writeFailed(message) });
      return;
    }
    this.pushState();
  }
}
