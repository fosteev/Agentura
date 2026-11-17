import { AntigravityAdapter } from '../antigravity/adapter';
import { AGY_NOT_FOUND, resolveAgyExecutable } from '../antigravity/executable';
import { listAgyModels } from '../antigravity/models';
import { ClaudeAdapter } from '../claude/adapter';
import { resolveExecutable as resolveClaudeExecutable } from '../claude/executable';
import { CodexAdapter } from '../codex/adapter';
import { CODEX_NOT_FOUND, resolveCodexExecutable } from '../codex/executable';
import { CursorAdapter } from '../cursor/adapter';
import { CURSOR_NOT_FOUND, resolveCursorExecutable } from '../cursor/executable';
import { KimiAdapter } from '../kimi/adapter';
import { KIMI_NOT_FOUND, resolveKimiExecutable } from '../kimi/executable';
import { KimiCatalogError, loadKimiModels } from '../kimi/models';
import { GeminiAdapter } from '../gemini/adapter';
import { GEMINI_NOT_FOUND, resolveGeminiExecutable } from '../gemini/executable';
import { loadGeminiModels } from '../gemini/models';
import { ZCodeAdapter } from '../zcode/adapter';
import { ZCODE_NOT_FOUND, resolveZCodeExecutable } from '../zcode/executable';
import type { AgentAdapter, AgentProvider } from '../types';
import type { ProviderInspectResult, ProviderRuntime } from './types';

export interface ProviderRuntimeConfig {
  executableSetting?: () => string;
  executablePath?: string | (() => string | undefined | Promise<string | undefined>);
  clientVersion?: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface CreateProviderRuntimesOptions {
  claude?: ProviderRuntimeConfig;
  codex?: ProviderRuntimeConfig;
  kimi?: ProviderRuntimeConfig;
  antigravity?: ProviderRuntimeConfig;
  cursor?: ProviderRuntimeConfig;
  gemini?: ProviderRuntimeConfig;
  zcode?: ProviderRuntimeConfig;
}

function isAuthErrorText(message: string): boolean {
  return /(?:not\s+(?:logged|signed)\s+in|not\s+authenticated|login\s+required|sign[ -]?in\s+required|unauthorized|http\s*401|auth.*required|invalid.*token|please\s+log\s*in|oauth\s+session\s+expired|failed\s+to\s+authenticate|ineligibletiererror|project_token_login_failed|insufficient\s+balance|1113)/i.test(
    message,
  );
}

function resolveSetting(cfg?: ProviderRuntimeConfig): string {
  const s = cfg?.executableSetting?.();
  return typeof s === 'string' ? s : '';
}

export function createClaudeRuntime(cfg: ProviderRuntimeConfig = {}): ProviderRuntime {
  let cachedAdapter: ClaudeAdapter | undefined;
  let resolvedPath: string | undefined;

  const resolvePath = async () => {
    const explicit =
      typeof cfg.executablePath === 'function' ? await cfg.executablePath() : cfg.executablePath;
    if (explicit) {
      resolvedPath = explicit;
      return { path: explicit, problem: undefined };
    }
    const r = await resolveClaudeExecutable(resolveSetting(cfg));
    if (r.path && !r.problem) resolvedPath = r.path;
    return { path: r.path && !r.problem ? r.path : undefined, problem: r.problem };
  };

  const getAdapter = (): AgentAdapter => {
    cachedAdapter ??= new ClaudeAdapter({
      executablePath: async () => {
        if (resolvedPath) return resolvedPath;
        const r = await resolvePath();
        return r.path;
      },
      clientApp: 'agentura',
      ...(cfg.log ? { log: cfg.log } : {}),
    });
    return cachedAdapter;
  };

  return {
    provider: 'claude' satisfies AgentProvider,
    label: 'Claude Code',
    adapter: getAdapter,
    inspect: async (cwd: string): Promise<ProviderInspectResult> => {
      const { path, problem } = await resolvePath();
      if (!path) {
        return {
          status: 'unavailable',
          models: [],
          reason: problem ?? 'Claude CLI was not found.',
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
      try {
        const { account, models } = await (getAdapter() as ClaudeAdapter).inspectCapabilities(cwd);
        const hasAuth = Boolean(
          account.email ||
            account.subscriptionType ||
            account.tokenSource ||
            account.apiProvider ||
            process.env['ANTHROPIC_API_KEY'],
        );
        if (!hasAuth) {
          return {
            status: 'needs_auth',
            models: [],
            reason: 'Claude Code is not authenticated. Sign in with `claude` first.',
            supportedAccess: ['read_only', 'workspace_write', 'full_access'],
            supportsFineGrainedWritePaths: false,
            canDelegateViaMcp: true,
          };
        }
        return {
          status: 'ready',
          models,
          defaultModel: models.find((m) => m.value === 'default')?.value ?? models[0]?.value ?? null,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: isAuthErrorText(msg) ? 'needs_auth' : 'unavailable',
          models: [],
          reason: msg,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
    },
  };
}

export function createCodexRuntime(cfg: ProviderRuntimeConfig = {}): ProviderRuntime {
  let cachedAdapter: CodexAdapter | undefined;
  let resolvedPath: string | undefined;

  const resolvePath = async () => {
    const explicit =
      typeof cfg.executablePath === 'function' ? await cfg.executablePath() : cfg.executablePath;
    if (explicit) {
      resolvedPath = explicit;
      return { path: explicit, problem: undefined };
    }
    const r = await resolveCodexExecutable(resolveSetting(cfg));
    if (r.path && !r.problem) resolvedPath = r.path;
    return { path: r.path && !r.problem ? r.path : undefined, problem: r.problem };
  };

  const getAdapter = (): AgentAdapter => {
    cachedAdapter ??= new CodexAdapter({
      executablePath: async () => {
        if (resolvedPath) return resolvedPath;
        const r = await resolvePath();
        return r.path;
      },
      ...(cfg.clientVersion ? { clientVersion: cfg.clientVersion } : {}),
      ...(cfg.log ? { log: cfg.log } : {}),
    });
    return cachedAdapter;
  };

  return {
    provider: 'codex' satisfies AgentProvider,
    label: 'Codex',
    adapter: getAdapter,
    inspect: async (cwd: string): Promise<ProviderInspectResult> => {
      const { path, problem } = await resolvePath();
      if (!path) {
        return {
          status: 'unavailable',
          models: [],
          reason: problem ?? CODEX_NOT_FOUND,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
      try {
        const models = await (getAdapter() as CodexAdapter).listModels(cwd);
        return {
          status: 'ready',
          models,
          defaultModel: models[0]?.value ?? null,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: isAuthErrorText(msg) ? 'needs_auth' : 'unavailable',
          models: [],
          reason: msg,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
    },
  };
}

export function createKimiRuntime(cfg: ProviderRuntimeConfig = {}): ProviderRuntime {
  let cachedAdapter: KimiAdapter | undefined;
  let resolvedPath: string | undefined;

  const resolvePath = async () => {
    const explicit =
      typeof cfg.executablePath === 'function' ? await cfg.executablePath() : cfg.executablePath;
    if (explicit) {
      resolvedPath = explicit;
      return { path: explicit, version: '2.6.0', problem: undefined };
    }
    const r = await resolveKimiExecutable(resolveSetting(cfg));
    if (r.path && r.version) resolvedPath = r.path;
    return { path: r.path && r.version ? r.path : undefined, version: r.version, problem: r.problem };
  };

  const getAdapter = (): AgentAdapter => {
    cachedAdapter ??= new KimiAdapter({
      executablePath: async () => {
        if (resolvedPath) return resolvedPath;
        const r = await resolvePath();
        return r.path;
      },
      ...(cfg.clientVersion ? { clientVersion: cfg.clientVersion } : {}),
      ...(cfg.log ? { log: cfg.log } : {}),
    });
    return cachedAdapter;
  };

  return {
    provider: 'kimi' satisfies AgentProvider,
    label: 'Kimi Code',
    adapter: getAdapter,
    inspect: async (): Promise<ProviderInspectResult> => {
      const { path, version, problem } = await resolvePath();
      if (!path || !version) {
        return {
          status: 'unavailable',
          models: [],
          reason: problem ?? KIMI_NOT_FOUND,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
      try {
        const models = await loadKimiModels(path);
        return {
          status: 'ready',
          models,
          defaultModel: models[0]?.value ?? null,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const needsAuth = err instanceof KimiCatalogError ? err.signedOut : isAuthErrorText(msg);
        return {
          status: needsAuth ? 'needs_auth' : 'unavailable',
          models: [],
          reason: msg,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
    },
  };
}

export function createAntigravityRuntime(cfg: ProviderRuntimeConfig = {}): ProviderRuntime {
  let cachedAdapter: AntigravityAdapter | undefined;
  let resolvedPath: string | undefined;
  let resolvedVersion: string | undefined;

  const resolvePath = async () => {
    const explicit =
      typeof cfg.executablePath === 'function' ? await cfg.executablePath() : cfg.executablePath;
    if (explicit) {
      resolvedPath = explicit;
      return { path: explicit, version: resolvedVersion ?? '1.5.0', problem: undefined };
    }
    const r = await resolveAgyExecutable(resolveSetting(cfg));
    if (r.path && r.version && !r.problem) {
      resolvedPath = r.path;
      resolvedVersion = r.version;
    }
    return {
      path: r.path && r.version && !r.problem ? r.path : undefined,
      version: r.version,
      problem: r.problem,
    };
  };

  const getAdapter = (): AgentAdapter => {
    cachedAdapter ??= new AntigravityAdapter({
      executablePath: async () => {
        if (resolvedPath) return resolvedPath;
        const r = await resolvePath();
        return r.path;
      },
      engineVersion: () => resolvedVersion,
      ...(cfg.log ? { log: cfg.log } : {}),
    });
    return cachedAdapter;
  };

  return {
    provider: 'antigravity' satisfies AgentProvider,
    label: 'Antigravity',
    adapter: getAdapter,
    inspect: async (cwd: string): Promise<ProviderInspectResult> => {
      const { path, version, problem } = await resolvePath();
      if (!path || !version) {
        return {
          status: 'unavailable',
          models: [],
          reason: problem ?? AGY_NOT_FOUND,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
      try {
        const models = await listAgyModels(path);
        if (models.length === 0) {
          const acct = await (getAdapter() as AntigravityAdapter).accountInfo(cwd).catch(() => ({}));
          const hasAuth = Boolean((acct as { subscriptionType?: string }).subscriptionType);
          return {
            status: hasAuth ? 'unavailable' : 'needs_auth',
            models: [],
            reason: hasAuth
              ? 'Antigravity CLI returned no available models.'
              : 'Antigravity CLI is not authenticated.',
            supportedAccess: ['read_only', 'workspace_write', 'full_access'],
            supportsFineGrainedWritePaths: false,
            canDelegateViaMcp: true,
          };
        }
        const preferredDefault =
          models.find((m) => m.value.startsWith('gemini-4-hydrogen'))?.value ??
          models.find((m) => !m.value.startsWith('claude-'))?.value ??
          models[0]?.value ??
          null;
        return {
          status: 'ready',
          models,
          defaultModel: preferredDefault,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: isAuthErrorText(msg) ? 'needs_auth' : 'unavailable',
          models: [],
          reason: msg,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
    },
  };
}

export function createCursorRuntime(cfg: ProviderRuntimeConfig = {}): ProviderRuntime {
  let cachedAdapter: CursorAdapter | undefined;
  let resolvedPath: string | undefined;

  const resolvePath = async () => {
    const explicit =
      typeof cfg.executablePath === 'function' ? await cfg.executablePath() : cfg.executablePath;
    if (explicit) {
      resolvedPath = explicit;
      return { path: explicit, problem: undefined };
    }
    const r = await resolveCursorExecutable(resolveSetting(cfg));
    if (r.path && !r.problem) resolvedPath = r.path;
    return { path: r.path && !r.problem ? r.path : undefined, problem: r.problem };
  };

  const getAdapter = (): AgentAdapter => {
    cachedAdapter ??= new CursorAdapter({
      executablePath: async () => {
        if (resolvedPath) return resolvedPath;
        const r = await resolvePath();
        return r.path;
      },
      ...(cfg.clientVersion ? { clientVersion: cfg.clientVersion } : {}),
      ...(cfg.log ? { log: cfg.log } : {}),
    });
    return cachedAdapter;
  };

  return {
    provider: 'cursor' satisfies AgentProvider,
    label: 'Cursor',
    adapter: getAdapter,
    inspect: async (cwd: string): Promise<ProviderInspectResult> => {
      const { path, problem } = await resolvePath();
      if (!path) {
        return {
          status: 'unavailable',
          models: [],
          reason: problem ?? CURSOR_NOT_FOUND,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
      try {
        const cursor = getAdapter() as CursorAdapter;
        const [{ models, defaultModel }, acct] = await Promise.all([
          cursor.listModels(cwd),
          cursor.accountInfo(cwd).catch(() => ({} as { email?: string; subscriptionType?: string })),
        ]);
        const hasAuth = Boolean(acct.email || acct.subscriptionType || process.env['CURSOR_API_KEY'] || models.length > 0);
        if (!hasAuth) {
          return {
            status: 'needs_auth',
            models: [],
            reason: 'Cursor CLI is not authenticated. Run `agent login` first.',
            supportedAccess: ['read_only', 'workspace_write', 'full_access'],
            supportsFineGrainedWritePaths: false,
            canDelegateViaMcp: true,
          };
        }
        return {
          status: 'ready',
          models,
          defaultModel: defaultModel ?? models[0]?.value ?? null,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: isAuthErrorText(msg) ? 'needs_auth' : 'unavailable',
          models: [],
          reason: msg,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
    },
  };
}

export function createGeminiRuntime(cfg: ProviderRuntimeConfig = {}): ProviderRuntime {
  let cachedAdapter: GeminiAdapter | undefined;
  let resolvedPath: string | undefined;

  const resolvePath = async () => {
    const explicit =
      typeof cfg.executablePath === 'function' ? await cfg.executablePath() : cfg.executablePath;
    if (explicit) {
      resolvedPath = explicit;
      return { path: explicit, problem: undefined };
    }
    const r = await resolveGeminiExecutable(resolveSetting(cfg));
    if (r.path && !r.problem) resolvedPath = r.path;
    return { path: r.path && !r.problem ? r.path : undefined, problem: r.problem };
  };

  const getAdapter = (): AgentAdapter => {
    cachedAdapter ??= new GeminiAdapter({
      executablePath: async () => {
        if (resolvedPath) return resolvedPath;
        const r = await resolvePath();
        return r.path;
      },
      ...(cfg.clientVersion ? { clientVersion: cfg.clientVersion } : {}),
      ...(cfg.log ? { log: cfg.log } : {}),
    });
    return cachedAdapter;
  };

  return {
    provider: 'gemini' satisfies AgentProvider,
    label: 'Gemini CLI',
    adapter: getAdapter,
    inspect: async (cwd: string): Promise<ProviderInspectResult> => {
      const { path, problem } = await resolvePath();
      if (!path) {
        return {
          status: 'unavailable',
          models: [],
          reason: problem ?? GEMINI_NOT_FOUND,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
      try {
        const gemini = getAdapter() as GeminiAdapter;
        const [cliModels, probe] = await Promise.all([
          loadGeminiModels(path).catch(() => []),
          gemini.probeAuth(cwd),
        ]);
        const models = cliModels.length > 0 ? cliModels : probe.models;
        const preferred = models.find((m) => m.value === 'gemini-2.5-pro')?.value ?? models[0]?.value ?? null;
        if (!probe.ok) {
          return {
            status: probe.needsAuth || isAuthErrorText(probe.reason ?? '') ? 'needs_auth' : 'unavailable',
            models,
            ...(preferred ? { defaultModel: preferred } : {}),
            reason: probe.reason ?? 'Gemini CLI authentication or workspace check failed.',
            supportedAccess: ['read_only', 'workspace_write', 'full_access'],
            supportsFineGrainedWritePaths: false,
            canDelegateViaMcp: true,
          };
        }
        return {
          status: 'ready',
          models,
          defaultModel: preferred,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: isAuthErrorText(msg) ? 'needs_auth' : 'unavailable',
          models: [],
          reason: msg,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: true,
        };
      }
    },
  };
}

export function createZCodeRuntime(cfg: ProviderRuntimeConfig = {}): ProviderRuntime {
  let cachedAdapter: ZCodeAdapter | undefined;
  let resolvedPath: string | undefined;

  const resolvePath = async () => {
    const explicit =
      typeof cfg.executablePath === 'function' ? await cfg.executablePath() : cfg.executablePath;
    if (explicit) {
      resolvedPath = explicit;
      return { path: explicit, problem: undefined };
    }
    const r = await resolveZCodeExecutable(resolveSetting(cfg));
    if (r.path && !r.problem) resolvedPath = r.path;
    return { path: r.path && !r.problem ? r.path : undefined, problem: r.problem };
  };

  const getAdapter = (): AgentAdapter => {
    cachedAdapter ??= new ZCodeAdapter({
      executablePath: async () => {
        if (resolvedPath) return resolvedPath;
        const r = await resolvePath();
        return r.path;
      },
      ...(cfg.clientVersion ? { clientVersion: cfg.clientVersion } : {}),
      ...(cfg.log ? { log: cfg.log } : {}),
    });
    return cachedAdapter;
  };

  return {
    provider: 'zcode' satisfies AgentProvider,
    label: 'ZCode',
    adapter: getAdapter,
    inspect: async (cwd: string): Promise<ProviderInspectResult> => {
      const { path, problem } = await resolvePath();
      if (!path) {
        return {
          status: 'unavailable',
          models: [],
          reason: problem ?? ZCODE_NOT_FOUND,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: false,
        };
      }
      try {
        const zcode = getAdapter() as ZCodeAdapter;
        const res = await zcode.inspectRuntime(cwd);
        const preferred = res.models[0]?.value ?? null;
        return {
          status: res.authenticated ? 'ready' : 'needs_auth',
          models: res.models,
          ...(preferred ? { defaultModel: preferred } : {}),
          ...(res.reason ? { reason: res.reason } : {}),
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          // zcode app-server does not support per-session HTTP mcpServers injection without mutating ~/.zcode
          canDelegateViaMcp: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: isAuthErrorText(msg) ? 'needs_auth' : 'unavailable',
          models: [],
          reason: msg,
          supportedAccess: ['read_only', 'workspace_write', 'full_access'],
          supportsFineGrainedWritePaths: false,
          canDelegateViaMcp: false,
        };
      }
    },
  };
}

export function createProviderRuntimes(options: CreateProviderRuntimesOptions = {}): ProviderRuntime[] {
  return [
    createClaudeRuntime(options.claude),
    createCodexRuntime(options.codex),
    createKimiRuntime(options.kimi),
    createAntigravityRuntime(options.antigravity),
    createCursorRuntime(options.cursor),
    createGeminiRuntime(options.gemini),
    createZCodeRuntime(options.zcode),
  ];
}
