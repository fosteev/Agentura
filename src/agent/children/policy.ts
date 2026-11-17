import { sep } from 'node:path';
import type { EffortLevel, PermissionDecision, SessionOptions } from '../types';
import { resolveInsideWorkspace } from './ownership';
import {
  ChildAgentError,
  type ChildAccessMode,
  type ChildPolicy,
  type HostMcpServerConfig,
  type ProviderInspectResult,
} from './types';

export function accessRank(mode: ChildAccessMode): number {
  switch (mode) {
    case 'read_only':
      return 0;
    case 'workspace_write':
      return 1;
    case 'full_access':
      return 2;
  }
}

export function validateChildPolicy(
  requested: ChildPolicy,
  parentMaxAccess: ChildAccessMode,
  allowBypassPermissions: boolean | undefined,
  inspectResult: ProviderInspectResult,
): void {
  if (accessRank(requested.access) > accessRank(parentMaxAccess)) {
    throw new ChildAgentError(
      'POLICY_ESCALATION_DENIED',
      `Requested access "${requested.access}" exceeds parent max access "${parentMaxAccess}"`,
    );
  }

  if (requested.access === 'full_access' && !allowBypassPermissions) {
    throw new ChildAgentError(
      'POLICY_ESCALATION_DENIED',
      'full_access requires agentura.allowBypassPermissions',
    );
  }

  if (!inspectResult.supportedAccess.includes(requested.access)) {
    throw new ChildAgentError(
      'POLICY_UNSUPPORTED_BY_ENGINE',
      `Provider does not support access "${requested.access}"`,
    );
  }

  if (
    requested.access !== 'read_only' &&
    requested.isolation !== 'worktree' &&
    (!requested.writePaths || !requested.writePaths.includes('.')) &&
    !inspectResult.supportsFineGrainedWritePaths
  ) {
    throw new ChildAgentError(
      'POLICY_UNSUPPORTED_BY_ENGINE',
      'Engine cannot enforce narrow file-level write_paths in shared workspace; use write_paths: ["."] for exclusive workspace lock or isolation: "worktree".',
    );
  }

  if (requested.allowDelegate === true && !inspectResult.canDelegateViaMcp) {
    throw new ChildAgentError(
      'POLICY_UNSUPPORTED_BY_ENGINE',
      'Provider engine does not support child delegation via MCP',
    );
  }
}

export interface ChildExtendedSessionOptions extends SessionOptions {
  hostMcpServers?: HostMcpServerConfig[];
}

export function buildChildSessionOptions(
  provider: string,
  policy: ChildPolicy,
  cwd: string,
  model?: string | null,
  effort?: EffortLevel | string | null,
  hostMcpServers?: HostMcpServerConfig[],
): ChildExtendedSessionOptions {
  const options: ChildExtendedSessionOptions = {
    cwd,
  };

  if (model) {
    options.model = model;
  }

  if (effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    options.effort = effort as EffortLevel;
  }

  if (hostMcpServers && hostMcpServers.length > 0) {
    options.hostMcpServers = hostMcpServers;
  }

  if (provider === 'codex') {
    if (policy.access === 'read_only') {
      options.codexDefaults = { sandbox: 'readOnly', approval: 'never' };
    } else if (policy.access === 'workspace_write') {
      options.codexDefaults = { sandbox: 'workspaceWrite', approval: 'never' };
    } else if (policy.access === 'full_access') {
      options.codexDefaults = { sandbox: 'dangerFullAccess', approval: 'never' };
      options.allowBypassPermissions = true;
    }
  } else {
    // claude, kimi, antigravity, cursor, gemini, zcode
    if (policy.access === 'read_only') {
      options.permissionMode = 'default';
    } else if (policy.access === 'workspace_write') {
      if (policy.writePaths?.includes('.') || policy.isolation === 'worktree') {
        options.permissionMode = 'acceptEdits';
      } else {
        options.permissionMode = 'default';
      }
    } else if (policy.access === 'full_access') {
      options.permissionMode = 'bypassPermissions';
      options.allowBypassPermissions = true;
    }
  }

  return options;
}

export interface ChildPermissionRequest {
  toolName: string;
  title?: string;
  input: Record<string, unknown>;
  blockedPath?: string;
}

const AGENTURA_AGENTS_TOOL_NAMES = new Set([
  'agents_catalog',
  'agent_spawn',
  'agent_status',
  'agent_wait',
  'agent_send',
  'agent_stop',
]);

const AGENTURA_AGENTS_PREFIXES = [
  'mcp__agentura_agents__',
  'mcp_agentura_agents_',
  'agentura_agents/',
  'agentura_agents:',
  'agentura_agents.',
  'agentura_agents_',
];

export function isAgenturaAgentsTool(toolName: string, title?: string): boolean {
  const lower = toolName.trim().toLowerCase();
  if (AGENTURA_AGENTS_TOOL_NAMES.has(lower) || lower === 'agentura_agents') {
    return true;
  }
  if (AGENTURA_AGENTS_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  // Do not let a shell/file tool title spoof an agentura_agents MCP call.
  if (
    READ_ONLY_TOOLS.has(lower) ||
    MUTATING_FILE_TOOLS.has(lower) ||
    COMMAND_TOOLS.has(lower)
  ) {
    return false;
  }
  if (title) {
    const t = title.trim().toLowerCase();
    if (AGENTURA_AGENTS_TOOL_NAMES.has(t) || AGENTURA_AGENTS_PREFIXES.some((p) => t.startsWith(p))) {
      return true;
    }
    if (t.includes('agentura_agents')) {
      for (const name of AGENTURA_AGENTS_TOOL_NAMES) {
        if (t.includes(name)) return true;
      }
    }
    for (const name of AGENTURA_AGENTS_TOOL_NAMES) {
      if (t.startsWith(`${name}:`) || t.startsWith(`${name} `) || t.includes(`mcp tool ${name}`)) {
        return true;
      }
    }
  }
  return false;
}

const READ_ONLY_TOOLS = new Set([
  'read',
  'read_file',
  'grep',
  'grep_search',
  'glob',
  'find_by_name',
  'ls',
  'list_directory',
  'view',
  'show_directory',
]);

const MUTATING_FILE_TOOLS = new Set([
  'edit',
  'edit_file',
  'write',
  'write_file',
  'multiedit',
  'notebookedit',
  'create_file',
]);

const COMMAND_TOOLS = new Set([
  'bash',
  'run_command',
  'terminal',
  'exec_command',
]);

export function decideChildPermission(
  req: ChildPermissionRequest,
  policy: ChildPolicy,
  cwd: string,
): PermissionDecision {
  const toolLower = req.toolName.toLowerCase();

  // Child MCP agentura_agents tools
  if (isAgenturaAgentsTool(req.toolName, req.title)) {
    return policy.allowDelegate !== false ? 'allow' : 'deny';
  }

  if (policy.access === 'read_only') {
    if (READ_ONLY_TOOLS.has(toolLower)) {
      return 'allow';
    }
    // Any mutating tool or shell command or unknown tool is denied in read_only
    return 'deny';
  }

  if (policy.access === 'full_access') {
    return 'allow';
  }

  // workspace_write
  if (READ_ONLY_TOOLS.has(toolLower)) {
    return 'allow';
  }

  const isNarrowPaths =
    policy.isolation !== 'worktree' &&
    policy.writePaths &&
    !policy.writePaths.includes('.');

  if (isNarrowPaths) {
    // Shell execution cannot be restricted to specific files
    if (COMMAND_TOOLS.has(toolLower)) {
      return 'deny';
    }

    if (MUTATING_FILE_TOOLS.has(toolLower)) {
      const rawTarget =
        req.input['filePath'] ??
        req.input['path'] ??
        req.input['file_path'] ??
        req.input['Path'] ??
        req.blockedPath;

      if (!rawTarget || typeof rawTarget !== 'string') {
        return 'deny';
      }

      let resolvedTarget: string;
      try {
        resolvedTarget = resolveInsideWorkspace(cwd, rawTarget);
      } catch {
        return 'deny';
      }

      // Check if resolvedTarget matches or is inside any allowed writePath
      const allowedPaths = (policy.writePaths ?? []).map((p) => {
        try {
          return resolveInsideWorkspace(cwd, p);
        } catch {
          return null;
        }
      });

      for (const allowed of allowedPaths) {
        if (!allowed) continue;
        if (resolvedTarget === allowed || resolvedTarget.startsWith(allowed + sep)) {
          return 'allow';
        }
      }

      return 'deny';
    }

    return 'deny';
  }

  // Entire workspace write (or worktree)
  if (req.blockedPath) {
    try {
      const resolvedBlocked = resolveInsideWorkspace(cwd, req.blockedPath);
      if (resolvedBlocked) {
        return 'allow';
      }
    } catch {
      return 'deny';
    }
  }

  return 'allow';
}
