import type { AgentEvent, DiffPreview, PermissionAlways, PermissionDecision, Question } from '../types';
import type { LogFn } from '../claude/adapter';
import type { RpcId } from './client';
import type {
  CommandApprovalDecision,
  CommandApprovalParams,
  FileChangeApprovalParams,
  FileSystemEntryPath,
  FileUpdateChange,
  GrantedPermissions,
  PermissionsApprovalParams,
  UserInputParams,
} from './protocol';
import { changePath, displayCommand, parseHunks, sidesOfHunks } from './patch';

export interface ApprovalHost {
  emit(event: AgentEvent): void;
  respond(id: RpcId, result: unknown): void;
  respondError(id: RpcId, message: string, code?: number): void;
  log: LogFn;
  /** Правки `fileChange`-элемента, о котором спрашивают (из `item/started`): превью в карточке. */
  changesOf(itemId: string): FileUpdateChange[] | undefined;
}

/** Ответ на запрос, который закрылся без нашего решения (Stop, закрытие сессии): отказ по схеме. */
const NO_GRANT: GrantedPermissions = {};

interface Pending {
  id: RpcId;
  kind: 'permission' | 'question';
  /** Ответ на «разрешить» / «разрешить всегда»; нет — кнопки «всегда» у запроса нет. */
  allow(always: boolean): unknown;
  deny: unknown;
  /** Stop/закрытие: отказ, который ещё и снимает ход (`cancel`), где схема это знает. */
  cancel: unknown;
  questions?: { id: string; question: string }[];
}

type DecisionList = readonly unknown[] | null | undefined;

/** Запрос принимает простое решение: списка нет — любое из схемы, список есть — только названное в нём. */
function offers(list: DecisionList, name: string): boolean {
  return !Array.isArray(list) || list.includes(name);
}

function amendmentOf(list: DecisionList, proposed: string[] | null | undefined): string[] | undefined {
  if (Array.isArray(list)) {
    for (const d of list) {
      if (d && typeof d === 'object' && 'acceptWithExecpolicyAmendment' in d) {
        const inner = (d as { acceptWithExecpolicyAmendment: { execpolicy_amendment?: string[] } }).acceptWithExecpolicyAmendment;
        if (Array.isArray(inner?.execpolicy_amendment)) return inner.execpolicy_amendment;
      }
    }
    return undefined;
  }
  return proposed ?? undefined;
}

function shown(command: string): string {
  return displayCommand(command);
}

/** Путь из `entries` (новая форма `fileSystem`) для показа: путь, glob или особое место (`root`, `tmpdir`). */
function entryPath(path: FileSystemEntryPath | undefined): string {
  if (!path) return '?';
  if (path.type === 'path') return path.path;
  if (path.type === 'glob_pattern') return path.pattern;
  const v = path.value;
  if (v.kind === 'root') return '/ (root)';
  if (v.kind === 'unknown') return v.path + (v.subpath ? `/${v.subpath}` : '');
  if (v.kind === 'project_roots') return `project roots${v.subpath ? `/${v.subpath}` : ''}`;
  return v.kind;
}

/** Что просят у `item/permissions/requestApproval`, коротко: `network`, `read /a`, `write /b`. */
function permissionParts(p: PermissionsApprovalParams['permissions'] | undefined): string[] {
  const parts: string[] = [];
  if (p?.network?.enabled) parts.push('network');
  for (const path of p?.fileSystem?.read ?? []) parts.push(`read ${path}`);
  for (const path of p?.fileSystem?.write ?? []) parts.push(`write ${path}`);
  // `entries` — то, чем схема заменяет read/write: выдаём их же, значит, и показываем все
  for (const e of p?.fileSystem?.entries ?? []) parts.push(`${e.access} ${entryPath(e.path)}`);
  return parts;
}

/**
 * Запрошенное как выдаваемое: только непустые и показанные в карточке части (`null` — «не просят»). Поля
 * `fileSystem`, которых карточка не знает, не выдаём — пользователь их не видел.
 */
function grantOf(p: PermissionsApprovalParams['permissions'] | undefined): GrantedPermissions {
  const out: GrantedPermissions = {};
  if (p?.network && p.network.enabled !== null && p.network.enabled !== undefined) out.network = { enabled: p.network.enabled };
  const fs = p?.fileSystem;
  if (fs) {
    out.fileSystem = {
      read: fs.read ?? null,
      write: fs.write ?? null,
      ...(fs.entries ? { entries: fs.entries } : {}),
    };
  }
  return out;
}

/** Превью новой/изменённой файловой правки для карточки: один файл, `add` и `update`. */
function previewOf(changes: FileUpdateChange[] | undefined): DiffPreview | undefined {
  if (changes?.length !== 1) return undefined;
  const change = changes[0]!;
  const filePath = changePath(change);
  if (change.kind.type === 'add') return { kind: 'write', filePath, content: change.diff };
  if (change.kind.type !== 'update') return undefined;
  const hunks = parseHunks(change.diff);
  if (hunks.length === 0) return undefined;
  const { oldText, newText } = sidesOfHunks(hunks);
  return { kind: 'edit', filePath, oldText, newText, replaceAll: false };
}

/**
 * Server requests app-server → карточки и ответы. Запрос живёт в `pending` от прихода до ответа
 * пользователя, `serverRequest/resolved`, Stop или закрытия сессии: висящих запросов не остаётся, а
 * лента получает `permission.resolved` в каждом из этих случаев.
 */
export class CodexApprovals {
  private readonly pending = new Map<string, Pending>();

  /**
   * `prefix` делает `toolUseId` уникальным между процессами: id запросов у каждого app-server начинаются с 0, а
   * отвеченные карточки остаются в ленте вкладки — без префикса новая карточка совпала бы со старой и не показалась.
   */
  constructor(
    private readonly host: ApprovalHost,
    private readonly prefix = '',
  ) {}

  /** `toolUseId` карточки для id запроса JSON-RPC. */
  key(id: RpcId): string {
    return `${this.prefix}${String(id)}`;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Обработчик `onServerRequest` клиента. */
  handle(id: RpcId, method: string, params: unknown): void {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
          return this.command(id, params as CommandApprovalParams);
        case 'item/fileChange/requestApproval':
          return this.fileChange(id, params as FileChangeApprovalParams);
        case 'item/permissions/requestApproval':
          return this.permissions(id, params as PermissionsApprovalParams);
        case 'item/tool/requestUserInput':
          return this.userInput(id, params as UserInputParams);
        case 'mcpServer/elicitation/request':
          // форма MCP-сервера: рисовать нечем — отказ по схеме и видимая ошибка (а не молчаливое «не может»)
          this.host.respond(id, { action: 'decline', content: null, _meta: null });
          return this.refused(method, 'an MCP server asked for input, which Agentura cannot show yet; declined');
        default:
          this.host.respondError(id, `Method not supported: ${method}`, -32601);
          return this.refused(method, 'is not supported by Agentura');
      }
    } catch (error) {
      // битые params: не оставляем запрос без ответа
      this.host.log('error', `codex server request ${method} failed: ${String(error)}`);
      // карточка могла успеть встать в `pending`: ответ уже ушёл ошибкой, второго (Stop → cancel) быть не должно
      if (this.pending.delete(this.key(id))) {
        this.host.emit({ type: 'permission.resolved', toolUseId: this.key(id), decision: 'deny', by: 'abort' });
      }
      this.host.respondError(id, `Server request ${method} failed: ${String(error)}`);
    }
  }

  /** Решение пользователя по карточке разрешения (и отказ по вопросу). */
  respondPermission(toolUseId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(toolUseId);
    if (!p) return false;
    if (decision === 'deny') return this.finish(toolUseId, p, p.deny, 'deny');
    if (p.kind !== 'permission') return false;
    return this.finish(toolUseId, p, p.allow(decision === 'allow-always' || decision === 'allow-edits'), 'allow');
  }

  answerQuestion(toolUseId: string, answers: Record<string, string>): boolean {
    const p = this.pending.get(toolUseId);
    if (!p || p.kind !== 'question') return false;
    const out: Record<string, { answers: string[] }> = {};
    for (const q of p.questions ?? []) {
      const value = answers[q.question];
      if (value !== undefined && value !== '') out[q.id] = { answers: [value] };
    }
    return this.finish(toolUseId, p, { answers: out }, 'allow');
  }

  /** `serverRequest/resolved`: запрос закрыт сервером (не нами) — карточка снимается. */
  resolved(requestId: RpcId): void {
    const key = this.key(requestId);
    const p = this.pending.get(key);
    if (p) this.abort(key);
  }

  /** Stop: отвечаем на всё открытое отменой, чтобы сервер не ждал, и снимаем карточки. */
  cancelAll(): void {
    for (const [key, p] of [...this.pending]) {
      try {
        this.host.respond(p.id, p.cancel);
      } catch (error) {
        this.host.log('warn', `codex: cancelling request ${key} failed: ${String(error)}`);
      }
      this.abort(key);
    }
  }

  /** Процесс умер или сессию закрывают: отвечать некому, карточки снимаем. */
  dropAll(): void {
    for (const key of [...this.pending.keys()]) this.abort(key);
  }

  // ---- запросы -------------------------------------------------------------------------------

  private command(id: RpcId, params: CommandApprovalParams): void {
    const list = params.availableDecisions;
    const net = params.networkApprovalContext;
    const network = net?.host ? `network access to ${net.host} (${net.protocol})` : undefined;
    // без команды (запрос сетевого доступа) карточка показывает, что именно разрешают, а не пустой блок
    const command = params.command ? shown(params.command) : (network ?? '');
    const stdin = params.kind === 'writeStdin';
    // пояснение — в `input.description`: у карточки с командой видно только оно
    const note = [stdin ? 'send input to a running process' : undefined, params.command ? network : undefined]
      .filter(Boolean)
      .join(' · ');
    // «всегда»: сессионное решение, если оно есть, иначе постоянное правило Codex (если сервер его предлагает)
    const session = offers(list, 'acceptForSession');
    const amendment = session ? undefined : amendmentOf(list, params.proposedExecpolicyAmendment);
    const always: PermissionAlways | undefined = session
      ? { rules: [`Bash(${command})`], destination: 'session', directories: [] }
      : amendment?.length
        ? { rules: [`Bash(${amendment.join(' ')}:*)`], destination: 'codexRules', directories: [] }
        : undefined;
    const allowAlways: CommandApprovalDecision = session
      ? 'acceptForSession'
      : { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment ?? [] } };
    const toolUseId = this.add(id, {
      kind: 'permission',
      allow: (alwaysPick) => ({ decision: alwaysPick && always ? allowAlways : 'accept' }),
      deny: { decision: 'decline' },
      cancel: { decision: 'cancel' },
    });
    this.host.emit({
      type: 'permission.request',
      toolUseId,
      toolName: 'Bash',
      input: { command, ...(note ? { description: note } : {}) },
      ...(note ? { description: note } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      canAlwaysAllow: !!always,
      ...(always ? { always } : {}),
    });
  }

  private fileChange(id: RpcId, params: FileChangeApprovalParams): void {
    const changes = this.host.changesOf(params.itemId);
    const session = offers(params.availableDecisions, 'acceptForSession');
    const diff = session ? previewOf(changes) : undefined;
    const toolUseId = this.add(id, {
      kind: 'permission',
      allow: (always) => ({ decision: always && session ? 'acceptForSession' : 'accept' }),
      deny: { decision: 'decline' },
      cancel: { decision: 'cancel' },
    });
    const first = changes?.[0];
    const files = (changes ?? []).map(changePath);
    const single = changes?.length === 1;
    this.host.emit({
      type: 'permission.request',
      toolUseId,
      toolName: single && first?.kind.type === 'add' ? 'Write' : 'Edit',
      input: first ? { file_path: changePath(first) } : {},
      ...(files.length ? { description: files.join(', ') } : {}),
      ...(params.reason || params.grantRoot
        ? { reason: [params.reason, params.grantRoot ? `write access under ${params.grantRoot}` : undefined].filter(Boolean).join(' · ') }
        : {}),
      canAlwaysAllow: session,
      ...(session ? { always: { rules: [], directories: [], mode: 'acceptEdits' as const } } : {}),
      ...(diff ? { diff } : {}),
    });
  }

  private permissions(id: RpcId, params: PermissionsApprovalParams): void {
    const parts = permissionParts(params.permissions);
    const toolUseId = this.add(id, {
      kind: 'permission',
      allow: (always) => ({ permissions: grantOf(params.permissions), scope: always ? 'session' : 'turn' }),
      deny: { permissions: NO_GRANT, scope: 'turn' },
      cancel: { permissions: NO_GRANT, scope: 'turn' },
    });
    this.host.emit({
      type: 'permission.request',
      toolUseId,
      toolName: 'Permissions',
      // `command` — чтобы карточка показала запрос блоком (как команду) и строка отказа назвала его
      input: { command: parts.join(' · ') || 'additional permissions', permissions: params.permissions },
      description: parts.join(' · ') || 'additional permissions',
      ...(params.reason ? { reason: params.reason } : {}),
      canAlwaysAllow: parts.length > 0,
      ...(parts.length ? { always: { rules: parts, destination: 'session' as const, directories: [] } } : {}),
    });
  }

  private userInput(id: RpcId, params: UserInputParams): void {
    // секретный ввод (пароль, ключ) в ленту и журнал не несём: отказ ошибкой и видимое сообщение
    if (params.questions.some((q) => q.isSecret)) {
      this.host.respondError(id, 'Secret input is not supported by this client', -32601);
      return this.refused('item/tool/requestUserInput', 'asked for secret input, which Agentura does not collect');
    }
    const questions: Question[] = params.questions.map((q) => ({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      multiSelect: false,
    }));
    const toolUseId = this.add(id, {
      kind: 'question',
      allow: () => ({ answers: {} }),
      deny: { answers: {} },
      cancel: { answers: {} },
      questions: params.questions.map((q) => ({ id: q.id, question: q.question })),
    });
    this.host.emit({ type: 'question.request', toolUseId, questions });
  }

  // ---- учёт ------------------------------------------------------------------------------------

  private add(id: RpcId, rest: Omit<Pending, 'id'>): string {
    const key = this.key(id);
    this.pending.set(key, { id, ...rest });
    return key;
  }

  private finish(key: string, p: Pending, result: unknown, decision: 'allow' | 'deny'): boolean {
    this.pending.delete(key);
    this.host.respond(p.id, result);
    this.host.emit({ type: 'permission.resolved', toolUseId: key, decision, by: 'user' });
    return true;
  }

  private abort(key: string): void {
    this.pending.delete(key);
    this.host.emit({ type: 'permission.resolved', toolUseId: key, decision: 'deny', by: 'abort' });
  }

  private refused(method: string, why: string): void {
    this.host.log('warn', `codex server request ${method}: ${why}`);
    this.host.emit({ type: 'error', fatal: false, code: 'unsupported_request', message: `Codex request ${method} ${why}.` });
  }
}
