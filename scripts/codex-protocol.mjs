#!/usr/bin/env node
/**
 * Сверка `src/agent/codex/protocol.ts` с реальным протоколом: генерирует схему
 * `codex app-server generate-ts` во временную папку (в репо не попадает) и проверяет, что методы и поля,
 * которые использует Agentura, на месте. Списки ниже — зеркало `protocol.ts`, ведутся руками: сам protocol.ts
 * скрипт не разбирает. Код возврата 1 — расхождение (или нет CLI). В `npm run check` не входит (CI без codex).
 *
 *   npm run codex:protocol            # codex из PATH
 *   CODEX=/path/to/codex npm run codex:protocol
 *   npm run codex:protocol -- --keep  # не удалять папку со схемой, напечатать путь
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const codex = process.env.CODEX || 'codex';
const keep = process.argv.includes('--keep');

const METHODS = {
  'ClientRequest.ts': [
    'initialize',
    'thread/start',
    'thread/resume',
    'thread/read',
    'thread/list',
    'thread/name/set',
    'thread/compact/start',
    'turn/start',
    'turn/interrupt',
    'turn/steer',
    'model/list',
    'mcpServerStatus/list',
    'config/mcpServer/reload',
  ],
  'ServerRequest.ts': [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ],
  'ServerNotification.ts': [
    'thread/started',
    'thread/status/changed',
    'thread/name/updated',
    'thread/tokenUsage/updated',
    'thread/compacted',
    'turn/started',
    'turn/completed',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
    'item/fileChange/patchUpdated',
    'serverRequest/resolved',
    'error',
    'mcpServer/startupStatus/updated',
  ],
};

/** Файл (в корне или v2/) → поля, которые мы читаем или пишем. */
const FIELDS = {
  InitializeParams: ['clientInfo', 'capabilities'],
  InitializeCapabilities: ['experimentalApi', 'requestAttestation'],
  ThreadStartParams: ['cwd', 'model', 'approvalPolicy', 'sandbox', 'ephemeral'],
  ThreadResumeParams: ['threadId', 'excludeTurns'],
  ThreadStartResponse: ['thread', 'model', 'approvalPolicy', 'sandbox', 'reasoningEffort'],
  ThreadReadParams: ['threadId', 'includeTurns'],
  ThreadListParams: ['cursor', 'limit', 'sortKey', 'cwd', 'archived', 'sourceKinds', 'searchTerm'],
  ThreadListResponse: ['data', 'nextCursor'],
  ThreadSetNameParams: ['threadId', 'name'],
  Thread: ['id', 'preview', 'createdAt', 'updatedAt', 'status', 'path', 'cwd', 'name', 'turns'],
  Turn: ['id', 'items', 'status', 'error', 'startedAt', 'completedAt'],
  TurnStartParams: [
    'threadId',
    'input',
    'cwd',
    'approvalPolicy',
    'sandboxPolicy',
    'model',
    'effort',
  ],
  TurnInterruptParams: ['threadId', 'turnId'],
  TurnSteerParams: ['threadId', 'input', 'expectedTurnId'],
  ModelListResponse: ['data', 'nextCursor'],
  Model: [
    'id',
    'model',
    'displayName',
    'hidden',
    'supportedReasoningEfforts',
    'defaultReasoningEffort',
    'isDefault',
  ],
  CommandExecutionRequestApprovalParams: [
    'kind',
    'threadId',
    'turnId',
    'itemId',
    'reason',
    'command',
    'cwd',
    'proposedExecpolicyAmendment',
  ],
  CommandExecutionRequestApprovalResponse: ['decision'],
  FileChangeRequestApprovalParams: ['threadId', 'turnId', 'itemId', 'reason', 'grantRoot'],
  FileChangeRequestApprovalResponse: ['decision'],
  PermissionsRequestApprovalResponse: ['permissions', 'scope'],
  ToolRequestUserInputParams: ['questions', 'isBlocking'],
  ToolRequestUserInputResponse: ['answers'],
  ThreadTokenUsage: ['total', 'last', 'modelContextWindow'],
  CollabAgentState: ['status', 'message'],
  ErrorNotification: ['error', 'willRetry', 'threadId', 'turnId'],
  ListMcpServerStatusParams: ['cursor', 'limit', 'detail', 'threadId'],
  ListMcpServerStatusResponse: ['data', 'nextCursor'],
  McpServerStatus: ['name', 'runtimeStatus', 'serverInfo', 'tools', 'toolsError', 'pluginId'],
  McpServerInfo: ['name', 'version'],
  McpServerStatusUpdatedNotification: ['threadId', 'name', 'status', 'error', 'failureReason'],
};
/** Значения union-ов, на которые завязан маппер. */
const LITERALS = {
  CommandExecutionApprovalDecision: [
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
    'acceptWithExecpolicyAmendment',
  ],
  FileChangeApprovalDecision: ['accept', 'acceptForSession', 'decline', 'cancel'],
  McpServerStatusDetail: ['full', 'toolsAndAuthOnly'],
  McpServerConnectionStatus: [
    'notStarted',
    'starting',
    'connected',
    'authenticationRequired',
    'failed',
    'cancelled',
    'disabled',
  ],
  McpServerStartupState: ['starting', 'ready', 'failed', 'cancelled'],
  McpServerStartupFailureReason: ['reauthenticationRequired'],
  TurnStatus: ['completed', 'interrupted', 'failed', 'inProgress'],
  AskForApproval: ['untrusted', 'on-request', 'never'],
  SandboxMode: ['read-only', 'workspace-write', 'danger-full-access'],
  ThreadItem: [
    'userMessage',
    'agentMessage',
    'reasoning',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'plan',
    'collabAgentToolCall',
    'subAgentActivity',
  ],
  CollabAgentTool: [
    'spawnAgent',
    'sendInput',
    'resumeAgent',
    'wait',
    'closeAgent',
    'sendMessage',
    'followupTask',
    'interruptAgent',
    'listAgents',
  ],
  CollabAgentToolCallStatus: ['inProgress', 'completed', 'failed', 'interrupted'],
  CollabAgentStatus: ['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'],
  SubAgentActivityKind: ['started', 'interacted', 'interrupted', 'completed'],
};

const out = mkdtempSync(join(tmpdir(), 'codex-proto-'));
const problems = [];
try {
  const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim();
  execFileSync(codex, ['app-server', 'generate-ts', '--out', out], { stdio: 'ignore' });
  console.log(keep ? `${version}; схема в ${out}` : version);
  const read = (name) => {
    for (const p of [join(out, name), join(out, 'v2', name)])
      if (existsSync(p)) return readFileSync(p, 'utf8');
    return undefined;
  };
  for (const [file, methods] of Object.entries(METHODS)) {
    const src = read(file) ?? '';
    for (const m of methods)
      if (!src.includes(`"method": "${m}"`)) problems.push(`${file}: нет метода ${m}`);
  }
  for (const [type, fields] of Object.entries(FIELDS)) {
    const src = read(`${type}.ts`);
    if (src === undefined) {
      problems.push(`нет типа ${type}`);
      continue;
    }
    for (const f of fields)
      if (!new RegExp(`\\b${f}\\??:`).test(src)) problems.push(`${type}: нет поля ${f}`);
  }
  for (const [type, values] of Object.entries(LITERALS)) {
    const src = read(`${type}.ts`);
    if (src === undefined) {
      problems.push(`нет типа ${type}`);
      continue;
    }
    for (const v of values)
      if (!src.includes(`"${v}"`)) problems.push(`${type}: нет значения ${v}`);
  }
} catch (e) {
  problems.push(`не удалось сгенерировать схему: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (!keep) rmSync(out, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`Расхождения протокола CLI со списками скрипта (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  'Протокол CLI содержит всё из списков этого скрипта (методы, поля, значения). Списки ведутся руками ' +
    'вместе с protocol.ts: поменял protocol.ts — поправь списки.',
);
