import type { ModelOption, PermissionDecision, PermissionMode, TokenUsage } from '../types';

export type ZCodeMode = 'plan' | 'build' | 'edit' | 'yolo' | 'guarded';

export interface ZCodeModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

export interface ZCodeSessionSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode?: string;
  workspacePath?: string;
}

export function zcodeModeOfPermission(
  mode: PermissionMode | undefined,
  allowBypass: boolean,
): ZCodeMode {
  if (mode === 'plan') return 'plan';
  if (mode === 'acceptEdits') return 'edit';
  if (mode === 'bypassPermissions' && allowBypass) return 'yolo';
  return 'guarded';
}

export function permissionModeFromZCode(mode: string | undefined): PermissionMode {
  if (mode === 'plan') return 'plan';
  if (mode === 'edit') return 'acceptEdits';
  if (mode === 'yolo') return 'bypassPermissions';
  return 'default';
}

export function isZCodeAuthFailure(text: string): boolean {
  return /project_token_login_failed|Select a model before (?:sending a message|continuing)|1113|Insufficient balance|invalid.*token|unauthorized|Z\.ai user information is invalid/i.test(
    text,
  );
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function parseZCodeModelsFromSettings(source: unknown): ModelOption[] {
  const root = record(source);
  const avail =
    record(record(root?.settings)?.model)?.available ??
    record(root?.model)?.available ??
    root?.models;
  if (!Array.isArray(avail)) return [];
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const item of avail) {
    const row = record(item);
    if (!row) continue;
    const ref = record(row.ref);
    const providerId =
      typeof row.providerId === 'string'
        ? row.providerId
        : typeof ref?.providerId === 'string'
          ? ref.providerId
          : '';
    const modelId =
      typeof row.modelId === 'string'
        ? row.modelId
        : typeof ref?.modelId === 'string'
          ? ref.modelId
          : typeof row.id === 'string'
            ? row.id
            : '';
    if (!modelId) continue;
    const value = providerId ? `${providerId}/${modelId}` : modelId;
    if (seen.has(value)) continue;
    seen.add(value);
    const label =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : typeof row.displayName === 'string' && row.displayName.trim()
          ? row.displayName.trim()
          : typeof row.label === 'string' && row.label.trim()
            ? row.label.trim()
            : value;
    const providerLabel = typeof row.providerLabel === 'string' && row.providerLabel.trim() ? row.providerLabel.trim() : '';
    const displayName = providerLabel && label !== value ? `${label} (${providerLabel})` : label;
    out.push({ value, displayName, supportsEffort: false });
  }
  return out;
}

export function parseZCodeModelSelection(raw: string): ZCodeModelSelection {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
  }
  return { providerId: 'default', modelId: trimmed };
}

export function parseZCodeSessions(result: unknown, targetDir: string): ZCodeSessionSummary[] {
  const list = record(result)?.sessions;
  if (!Array.isArray(list)) return [];
  const out: ZCodeSessionSummary[] = [];
  for (const entry of list) {
    const row = record(entry);
    const id = typeof row?.sessionId === 'string' ? row.sessionId : '';
    if (!id) continue;
    const ws = record(row?.workspace);
    const wsPath = typeof ws?.workspacePath === 'string' ? ws.workspacePath : undefined;
    if (wsPath && targetDir && wsPath !== '<tmp>/work' && wsPath !== targetDir) continue;
    out.push({
      sessionId: id,
      title: (typeof row?.title === 'string' && row.title) || id,
      createdAt: typeof row?.createdAt === 'number' ? row.createdAt : Date.now(),
      updatedAt: typeof row?.updatedAt === 'number' ? row.updatedAt : Date.now(),
      ...(typeof row?.mode === 'string' ? { mode: row.mode } : {}),
      ...(wsPath ? { workspacePath: wsPath } : {}),
    });
  }
  return out;
}

export function zcodePermissionDecision(decision: PermissionDecision): { decision: 'allow' | 'deny' } {
  return { decision: decision === 'deny' ? 'deny' : 'allow' };
}

export function zcodeUsageOf(raw: unknown): TokenUsage {
  const u = record(raw);
  return {
    input: typeof u?.inputTokens === 'number' ? u.inputTokens : typeof u?.input === 'number' ? u.input : 0,
    output: typeof u?.outputTokens === 'number' ? u.outputTokens : typeof u?.output === 'number' ? u.output : 0,
    cacheRead: typeof u?.cacheReadTokens === 'number' ? u.cacheReadTokens : 0,
    cacheWrite: typeof u?.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0,
  };
}
