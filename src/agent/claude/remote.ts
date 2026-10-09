import { randomUUID } from 'node:crypto';
import { homedir, hostname as osHostname } from 'node:os';
import { basename, join } from 'node:path';
import type {
  PermissionMode as SdkPermissionMode,
  Query,
  SDKControlRequest,
  SDKControlResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  BridgeSessionHandle,
  RemoteCredentials,
} from '@anthropic-ai/claude-agent-sdk/bridge';
import type { AgentEvent, AgentEventOf, PermissionMode } from '../types';
import { readToken as readTokenFrom } from '../../data/agentmeter/desktop/token.ts';
import { arr, isObj, obj, str } from './json';
import {
  DEFAULT_DENY_MESSAGE,
  type PermissionObserver,
  type ResolvedBy,
  type ToolPermissionOptions,
  type ToolPermissionResult,
} from './permissions';

/**
 * Remote Control (roadmap 17): сессия Claude видна и управляема с claude.ai/code и телефона. В Agent SDK
 * CLI-флаг `--remote-control` не работает, поэтому мост свой — alpha-API `@anthropic-ai/claude-agent-sdk/bridge`
 * (так делает официальное расширение): создаём сессию на claude.ai, берём JWT воркера, подключаем
 * транспорт и пересылаем сообщения в обе стороны. Контракт — `bridge.d.ts` пакета SDK.
 *
 * Мост — ESM, расширение — CJS: грузим только динамическим `import()` (статический затащил бы его в бандл).
 */

/** Функции модуля моста, которые мы зовём; подменяется в тестах. */
export type BridgeModule = Pick<
  typeof import('@anthropic-ai/claude-agent-sdk/bridge'),
  | 'createCodeSession'
  | 'fetchRemoteCredentials'
  | 'attachBridgeSession'
  | 'isCredentialsFailure'
  | 'isCredentialsRejection'
  | 'isCreateSessionFailure'
>;

/** Настройки моста в `ClaudeAdapterConfig.remote`; всё необязательно — есть умолчания. */
export interface RemoteConfig {
  loadBridge?: () => Promise<BridgeModule>;
  /** OAuth-токен Claude Code; читается при каждом включении и обновлении (его обновляет Claude Code). */
  readToken?: () => string | undefined | Promise<string | undefined>;
  /** `agentura.remoteControlNamePrefix`; пусто — имя машины. */
  namePrefix?: () => string;
  /** `agentura.allowBypassPermissions`: переход в bypass с claude.ai. */
  allowBypass?: () => boolean;
  hostname?: () => string;
}

export type RemoteState = AgentEventOf<'remote.state'>['state'];
export type RemoteError = NonNullable<AgentEventOf<'remote.state'>['error']>;

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** Что мосту нужно от сессии. */
export interface RemoteHost {
  readonly cwd: string;
  /** Заголовок сессии (`SessionOptions.title`); нет — имя папки. */
  readonly title: string | undefined;
  /** Модель сессии, если известна. */
  model(): string | undefined;
  closed(): boolean;
  emit(event: AgentEvent): void;
  /** Промпт с claude.ai: в маппер (`notePrompt`) и в очередь движка. */
  prompt(message: SDKUserMessage, text: string): void;
  /** Ответ на запрос разрешения с claude.ai (`PermissionBroker.resolveExternal`). */
  resolvePermission(toolUseId: string, result: ToolPermissionResult): boolean;
  readonly query: Pick<
    Query,
    'interrupt' | 'setModel' | 'setPermissionMode' | 'stopTask' | 'backgroundTasks'
  >;
  log: Log;
}

export const REMOTE_BASE_URL = 'https://api.anthropic.com';
export const REMOTE_TIMEOUT_MS = 20_000;
/** Сколько ждать досылки очереди при выключении. */
export const REMOTE_FLUSH_MS = 2_000;
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export function remoteUrl(sessionId: string): string {
  return `https://claude.ai/code/${sessionId}`;
}

/** Токен по умолчанию — как у лимитов: `~/.claude/.credentials.json`, затем Keychain. */
function defaultToken(): string | undefined {
  return readTokenFrom({ claudeHome: join(homedir(), '.claude'), platform: process.platform }).token;
}

/** Текст промпта: строка content или text-блоки через перевод строки. */
export function promptText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .filter(isObj)
    .filter((b) => b['type'] === 'text')
    .map((b) => str(b['text']) ?? '')
    .join('\n');
}

/** Откуда промпт: мобильное приложение или веб (`client_platform` входящего сообщения). */
export function promptFrom(clientPlatform: unknown): 'phone' | 'web' {
  return /ios|android|mobile/i.test(String(clientPlatform)) ? 'phone' : 'web';
}

/** Отказ подключения: причина для `remote.state`. */
class Failure extends Error {
  constructor(
    readonly reason: RemoteError,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** Запрос разрешения, отправленный на claude.ai. */
interface Outstanding {
  toolUseId: string;
  input: Record<string, unknown>;
}

/** Текущее подключение: колбэки старого транспорта (после переподключения) отбрасываются по нему. */
interface Slot {
  handle?: BridgeSessionHandle;
}

export class RemoteBridge implements PermissionObserver {
  private state: RemoteState = 'off';
  private bridge: BridgeModule | undefined;
  private sessionId: string | undefined;
  private slot: Slot | undefined;
  /** Поколение включения: `disable()` во время подключения отменяет его результат. */
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** request_id → запрос; toolUseId → request_id. */
  private readonly requests = new Map<string, Outstanding>();
  private readonly byTool = new Map<string, string>();

  constructor(
    private readonly host: RemoteHost,
    private readonly config: RemoteConfig = {},
  ) {}

  get current(): RemoteState {
    return this.state;
  }

  private get handle(): BridgeSessionHandle | undefined {
    return this.slot?.handle;
  }

  /** Включить: сессия на claude.ai → JWT воркера → транспорт. Уже `on`/`connecting` — ничего. */
  async enable(): Promise<void> {
    if (this.state === 'on' || this.state === 'connecting') return;
    if (this.host.closed()) return;
    const gen = ++this.gen;
    this.setState('connecting');
    try {
      const token = await this.token();
      if (!token) throw new Failure('no-token');
      const bridge = await this.load();
      if (gen !== this.gen) return;
      const prefix = this.config.namePrefix?.().trim() || (this.config.hostname ?? osHostname)();
      const title = `${prefix} · ${this.host.title ?? basename(this.host.cwd)}`;
      const sid = await bridge.createCodeSession(
        REMOTE_BASE_URL,
        token,
        title,
        REMOTE_TIMEOUT_MS,
        [],
        undefined,
        this.host.cwd,
        this.host.model(),
      );
      if (bridge.isCredentialsRejection(sid)) throw new Failure('oauth');
      if (bridge.isCreateSessionFailure(sid))
        throw new Failure('rejected', [sid.reason, sid.status, sid.detail].filter(Boolean).join(' '));
      if (typeof sid !== 'string') throw new Failure('network');
      if (gen !== this.gen) return;
      const creds = await this.credentials(bridge, sid, token);
      if (gen !== this.gen) return;
      const slot = await this.attach(bridge, sid, creds);
      if (gen !== this.gen) {
        this.drop(slot);
        return;
      }
      this.sessionId = sid;
      this.slot = slot;
      this.schedule(creds.expires_in);
      this.setState('on');
      this.host.log('info', `Remote Control: сессия ${sid} подключена`);
    } catch (error) {
      if (gen !== this.gen) return;
      const f =
        error instanceof Failure
          ? error
          : new Failure('network', error instanceof Error ? error.message : String(error));
      this.host.log('warn', `Remote Control не включён: ${f.message}`);
      this.setState('error', f.reason, f.detail);
    }
  }

  /** Выключить: дослать очередь (до 2 с) и закрыть транспорт; сессия на claude.ai остаётся в списке. */
  async disable(): Promise<void> {
    this.gen++;
    this.clearTimer();
    const slot = this.slot;
    this.slot = undefined;
    const was = this.state;
    // запросы, ждущие ответа на claude.ai, снять там — отвечать на них больше некому
    if (slot?.handle) {
      for (const requestId of this.requests.keys()) this.safe(() => slot.handle?.sendControlCancelRequest(requestId));
    }
    this.requests.clear();
    this.byTool.clear();
    if (was !== 'off') this.setState('off');
    if (slot?.handle) await this.close(slot.handle);
  }

  // ── исходящие ──────────────────────────────────────────────────────────

  /** Сырое сообщение движка: `stream_event` не шлём, `result` — граница хода, остальное — как есть. */
  mirror(message: SDKMessage): void {
    const h = this.live();
    if (!h) return;
    this.safe(() => {
      if (message.type === 'stream_event') return;
      if (message.type === 'result') {
        h.sendResult();
        h.reportState('idle');
        return;
      }
      h.write(message);
    });
  }

  /** Промпт, набранный в ленте: на claude.ai его иначе не видно. */
  notePrompt(message: SDKUserMessage): void {
    const h = this.live();
    if (!h) return;
    this.safe(() => {
      h.write(message);
      h.reportState('running');
    });
  }

  // ── разрешения ─────────────────────────────────────────────────────────

  onRequest(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: ToolPermissionOptions,
  ): void {
    const h = this.live();
    if (!h) return;
    const requestId = randomUUID();
    const request = {
      subtype: 'can_use_tool',
      tool_name: toolName,
      input,
      tool_use_id: toolUseId,
      ...(options.suggestions?.length ? { permission_suggestions: options.suggestions } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason ? { decision_reason: options.decisionReason } : {}),
      ...(options.blockedPath ? { blocked_path: options.blockedPath } : {}),
      ...(options.agentID ? { agent_id: options.agentID } : {}),
    } as SDKControlRequest['request'];
    this.requests.set(requestId, { toolUseId, input });
    this.byTool.set(toolUseId, requestId);
    this.safe(() => {
      h.sendControlRequest({ type: 'control_request', request_id: requestId, request });
      h.reportState('requires_action');
    });
  }

  /** Запрос закрыт: ответили в ленте или движок отменил — снять его на claude.ai. */
  onSettled(toolUseId: string, by: ResolvedBy): void {
    const requestId = this.byTool.get(toolUseId);
    if (requestId === undefined) return;
    this.byTool.delete(toolUseId);
    this.requests.delete(requestId);
    const h = this.live();
    if (!h) return;
    this.safe(() => {
      if (by !== 'remote') h.sendControlCancelRequest(requestId);
      if (this.requests.size === 0) h.reportState('running');
    });
  }

  /** Ответ с claude.ai; `false` — не наш или битый (мост оставит запрос для повторной доставки). */
  private onPermissionResponse(res: SDKControlResponse): boolean | void {
    const r = obj(res?.response);
    const requestId = r ? str(r['request_id']) : undefined;
    const req = requestId !== undefined ? this.requests.get(requestId) : undefined;
    if (!r || requestId === undefined || !req) return false;
    if (r['subtype'] !== 'success') return false;
    const result = permissionResult(obj(r['response']), req.input);
    if (!result) return false;
    this.requests.delete(requestId);
    this.byTool.delete(req.toolUseId);
    if (!this.host.resolvePermission(req.toolUseId, result))
      this.host.log('debug', `Remote Control: ответ на ${req.toolUseId} опоздал — уже решено`);
    if (this.requests.size === 0) this.safe(() => this.live()?.reportState('running'));
  }

  // ── управление с claude.ai ─────────────────────────────────────────────

  private onSetPermissionMode(mode: SdkPermissionMode): { ok: true } | { ok: false; error: string } {
    if (!MODES.includes(mode as PermissionMode))
      return { ok: false, error: `Permission mode "${mode}" is not supported by Agentura` };
    if (mode === 'bypassPermissions' && !this.config.allowBypass?.())
      return {
        ok: false,
        error: 'bypassPermissions is disabled in Agentura (agentura.allowBypassPermissions)',
      };
    this.host.query
      .setPermissionMode(mode)
      .then(() => this.host.emit({ type: 'mode.changed', mode: mode as PermissionMode }))
      .catch((e: unknown) => this.host.log('warn', `Remote Control: режим ${mode} не принят: ${String(e)}`));
    return { ok: true };
  }

  private async onSetModel(
    model: string | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.host.query.setModel(model);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── входящие ───────────────────────────────────────────────────────────

  private onInbound(message: SDKMessage): void {
    if (message.type !== 'user' || this.host.closed()) return;
    const msg = message as SDKUserMessage & { client_platform?: unknown };
    const text = promptText(msg.message?.content);
    const uuid = (msg.uuid as string | undefined) ?? randomUUID();
    this.host.emit({ type: 'remote.prompt', uuid, text, from: promptFrom(msg.client_platform) });
    // content как пришёл: картинки с телефона уходят движку
    this.host.prompt(
      {
        type: 'user',
        message: msg.message,
        parent_tool_use_id: null,
        uuid: uuid as SDKUserMessage['uuid'],
      },
      text,
    );
    this.safe(() => this.live()?.reportState('running'));
  }

  // ── транспорт ──────────────────────────────────────────────────────────

  private async attach(
    bridge: BridgeModule,
    sessionId: string,
    creds: RemoteCredentials,
    initialSequenceNum?: number,
  ): Promise<Slot> {
    const slot: Slot = {};
    const mine = () => this.slot === slot;
    slot.handle = await bridge.attachBridgeSession({
      sessionId,
      ingressToken: creds.worker_jwt,
      apiBaseUrl: creds.api_base_url,
      epoch: creds.worker_epoch,
      ...(initialSequenceNum !== undefined ? { initialSequenceNum } : {}),
      onInboundMessage: (m) => {
        if (mine()) this.onInbound(m);
      },
      onPermissionResponse: (res) => (mine() ? this.onPermissionResponse(res) : false),
      onInterrupt: () => {
        if (!mine()) return;
        this.host.query
          .interrupt()
          .catch((e: unknown) => this.host.log('warn', `Remote Control: interrupt: ${String(e)}`));
      },
      onSetModel: (model) => this.onSetModel(model),
      onSetPermissionMode: (mode) => this.onSetPermissionMode(mode),
      onStopTask: (taskId) => this.host.query.stopTask(taskId),
      onBackgroundTasks: (toolUseId) => this.host.query.backgroundTasks(toolUseId),
      onClose: (code) => {
        if (mine()) this.onClose(code);
      },
    });
    this.safe(() => slot.handle?.reportMetadata({ cwd: this.host.cwd }));
    return slot;
  }

  /**
   * Транспорт умер. 401/4094 — JWT истёк или отвергнут: одна попытка подключиться заново со свежим;
   * 4090 — сессию подхватил другой воркер; прочее — ошибка с кодом.
   */
  private onClose(code: number | undefined): void {
    this.clearTimer();
    if (code === 401 || code === 4094) {
      void this.reattach(code);
      return;
    }
    this.slot = undefined;
    this.requests.clear();
    this.byTool.clear();
    this.host.log('warn', `Remote Control: транспорт закрыт (${code ?? 'без кода'})`);
    if (code === 4090) this.setState('off', 'superseded');
    else this.setState('error', 'closed', code !== undefined ? String(code) : undefined);
  }

  private async reattach(code: number): Promise<void> {
    const old = this.slot;
    const sid = this.sessionId;
    const bridge = this.bridge;
    const seq = old?.handle ? this.safe(() => old.handle?.getSequenceNum()) : undefined;
    this.slot = undefined;
    if (old?.handle) this.drop(old);
    // запросы на старом транспорте не ответят — карточки в ленте остаются
    this.requests.clear();
    this.byTool.clear();
    const gen = this.gen;
    try {
      if (!sid || !bridge) throw new Failure('closed', String(code));
      const token = await this.token();
      if (!token) throw new Failure('closed', String(code));
      const creds = await this.credentials(bridge, sid, token);
      if (gen !== this.gen) return;
      const slot = await this.attach(bridge, sid, creds, seq);
      if (gen !== this.gen) {
        this.drop(slot);
        return;
      }
      this.slot = slot;
      this.schedule(creds.expires_in);
      this.host.log('info', `Remote Control: переподключён после ${code}`);
    } catch (error) {
      if (gen !== this.gen) return;
      this.host.log('warn', `Remote Control: переподключение после ${code} не удалось: ${String(error)}`);
      this.setState('error', 'closed', String(code));
    }
  }

  /** Обновление JWT до истечения: свежий токен → новые учётные данные → тот же транспорт. */
  private schedule(expiresIn: number): void {
    this.clearTimer();
    const seconds = Math.max(60, (Number.isFinite(expiresIn) ? expiresIn : 0) * 0.8);
    this.timer = setTimeout(() => void this.refresh(), seconds * 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async refresh(): Promise<void> {
    this.timer = undefined;
    const slot = this.slot;
    const sid = this.sessionId;
    const bridge = this.bridge;
    if (this.state !== 'on' || !slot?.handle || !sid || !bridge) return;
    const gen = this.gen;
    try {
      const token = await this.token();
      if (!token) throw new Failure('no-token');
      const creds = await this.credentials(bridge, sid, token);
      if (gen !== this.gen || this.slot !== slot) return;
      await slot.handle.reconnectTransport({
        ingressToken: creds.worker_jwt,
        apiBaseUrl: creds.api_base_url,
        epoch: creds.worker_epoch,
      });
      if (gen !== this.gen || this.slot !== slot) return;
      this.schedule(creds.expires_in);
    } catch (error) {
      if (gen !== this.gen || this.slot !== slot) return;
      // JWT живёт часы: повторим через минуту; совсем истечёт — транспорт закроется с 401
      this.host.log('warn', `Remote Control: обновление JWT не удалось: ${String(error)}`);
      this.schedule(0);
    }
  }

  private async credentials(
    bridge: BridgeModule,
    sessionId: string,
    token: string,
  ): Promise<RemoteCredentials> {
    const creds = await bridge.fetchRemoteCredentials(sessionId, REMOTE_BASE_URL, token, REMOTE_TIMEOUT_MS);
    if (bridge.isCredentialsRejection(creds)) throw new Failure('oauth');
    if (bridge.isCredentialsFailure(creds))
      throw new Failure('rejected', 'status' in creds ? `${creds.reason} ${creds.status}` : creds.reason);
    if (!creds) throw new Failure('network');
    return creds;
  }

  private load(): Promise<BridgeModule> {
    if (this.bridge) return Promise.resolve(this.bridge);
    return (this.config.loadBridge ?? (() => import('@anthropic-ai/claude-agent-sdk/bridge')))().then(
      (m) => (this.bridge = m),
    );
  }

  private async token(): Promise<string | undefined> {
    return (await (this.config.readToken ?? defaultToken)()) || undefined;
  }

  /** Дослать очередь (не дольше 2 с) и закрыть. */
  private async close(handle: BridgeSessionHandle): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        handle.flush(),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, REMOTE_FLUSH_MS))),
      ]);
    } catch (error) {
      this.host.log('warn', `Remote Control: flush: ${String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.safe(() => handle.close());
  }

  /** Закрыть чужое (устаревшее) подключение без досылки. */
  private drop(slot: Slot): void {
    this.safe(() => slot.handle?.close());
  }

  private live(): BridgeSessionHandle | undefined {
    return this.state === 'on' ? this.handle : undefined;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private setState(state: RemoteState, error?: RemoteError, detail?: string): void {
    this.state = state;
    const url = state === 'on' && this.sessionId ? remoteUrl(this.sessionId) : undefined;
    this.host.emit({
      type: 'remote.state',
      state,
      ...(url ? { url } : {}),
      ...(error ? { error } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  /** Сбой моста никогда не роняет сессию: только в журнал. */
  private safe<T>(call: () => T): T | undefined {
    try {
      return call();
    } catch (error) {
      this.host.log('warn', `Remote Control: ${String(error)}`);
      return undefined;
    }
  }
}

/**
 * Ответ claude.ai на `can_use_tool` → результат для движка. Форма — `PermissionResult` SDK
 * (`behavior`, `updatedInput`, `updatedPermissions` | `message`, `interrupt`). Переход в bypass из
 * «всегда» выкидывается, как у кнопки в ленте: он решается только меню режима и настройкой.
 */
export function permissionResult(
  payload: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): ToolPermissionResult | undefined {
  if (!payload) return undefined;
  if (payload['behavior'] === 'allow') {
    const result: ToolPermissionResult = {
      behavior: 'allow',
      updatedInput: obj(payload['updatedInput']) ?? input,
    };
    const updates = arr(payload['updatedPermissions']).filter(
      (s) => !(isObj(s) && s['type'] === 'setMode' && s['mode'] === 'bypassPermissions'),
    );
    if (updates.length > 0) result.updatedPermissions = updates;
    return result;
  }
  if (payload['behavior'] === 'deny') {
    return {
      behavior: 'deny',
      message: str(payload['message']) || DEFAULT_DENY_MESSAGE,
      ...(payload['interrupt'] === true ? { interrupt: true } : {}),
    };
  }
  return undefined;
}
