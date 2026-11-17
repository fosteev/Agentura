import type { AgentEvent } from '../types';
import { ChildSessionManager, type ChildSessionManagerOptions } from './manager';
import { ChildAgentsMcpServer } from './mcpServer';
import type { AgentStopResult, ChildAccessMode, ProviderRuntime } from './types';

export interface ChildAgentsHost {
  bindSession(params: {
    rootTreeId: string;
    cwd: string;
    maxAccess: ChildAccessMode;
    allowBypassPermissions?: boolean;
  }): Promise<{ token: string; serverUrl: string }>;
  updateBinding(
    token: string,
    updates: {
      maxAccess?: ChildAccessMode;
      cwd?: string;
      allowBypassPermissions?: boolean;
    },
  ): void;
  subscribeTree(rootTreeId: string, listener: (event: AgentEvent) => void): () => void;
  linkSession(provider: string, sessionId: string, rootTreeId: string): void;
  findTreeIdBySession(provider: string, sessionId: string): string | undefined;
  hasManagedAgent(rootTreeId: string, agentId: string): boolean;
  stopFromHost(rootTreeId: string, agentId: string): Promise<AgentStopResult>;
  renderTranscript(rootTreeId: string, agentId: string): string | undefined;
  restoredEvents(rootTreeId: string): AgentEvent[];
  disposeTree(rootTreeId: string): Promise<void>;
  dispose(): Promise<void>;
}

export class ChildAgentsService implements ChildAgentsHost {
  readonly manager: ChildSessionManager;
  private server: ChildAgentsMcpServer | undefined;
  private serverStarting: Promise<ChildAgentsMcpServer> | undefined;
  private readonly knownTrees = new Set<string>();
  private disposed = false;

  constructor(options: ChildSessionManagerOptions = {}) {
    this.manager = new ChildSessionManager(options);
  }

  registerProvider(runtime: ProviderRuntime): void {
    this.manager.registerProvider(runtime);
  }

  private async ensureServer(): Promise<ChildAgentsMcpServer> {
    if (this.disposed) throw new Error('ChildAgentsService is disposed');
    if (this.server) return this.server;
    if (!this.serverStarting) {
      const srv = new ChildAgentsMcpServer(this.manager);
      this.serverStarting = srv.start().then(
        () => {
          this.server = srv;
          return srv;
        },
        (err) => {
          this.serverStarting = undefined;
          throw err;
        },
      );
    }
    return this.serverStarting;
  }

  async bindSession(params: {
    rootTreeId: string;
    cwd: string;
    maxAccess: ChildAccessMode;
    allowBypassPermissions?: boolean;
  }): Promise<{ token: string; serverUrl: string }> {
    const server = await this.ensureServer();
    if (this.disposed) throw new Error('ChildAgentsService is disposed');
    const binding = this.manager.createRootBinding(params);
    this.knownTrees.add(params.rootTreeId);
    return {
      token: binding.token,
      serverUrl: server.urlForToken(binding.token),
    };
  }

  updateBinding(
    token: string,
    updates: {
      maxAccess?: ChildAccessMode;
      cwd?: string;
      allowBypassPermissions?: boolean;
    },
  ): void {
    this.manager.updateRootBinding(token, updates);
  }

  subscribeTree(rootTreeId: string, listener: (event: AgentEvent) => void): () => void {
    return this.manager.subscribeTree(rootTreeId, listener);
  }

  linkSession(provider: string, sessionId: string, rootTreeId: string): void {
    this.manager.linkSessionToTree(provider, sessionId, rootTreeId);
  }

  findTreeIdBySession(provider: string, sessionId: string): string | undefined {
    return this.manager.findTreeIdBySession(provider, sessionId);
  }

  hasManagedAgent(rootTreeId: string, agentId: string): boolean {
    return this.manager.hasManagedAgent(rootTreeId, agentId);
  }

  stopFromHost(rootTreeId: string, agentId: string): Promise<AgentStopResult> {
    return this.manager.stopFromHost(rootTreeId, agentId);
  }

  renderTranscript(rootTreeId: string, agentId: string): string | undefined {
    return this.manager.renderTranscript(rootTreeId, agentId);
  }

  restoredEvents(rootTreeId: string): AgentEvent[] {
    return this.manager.restoredEvents(rootTreeId);
  }

  async disposeTree(rootTreeId: string): Promise<void> {
    this.knownTrees.delete(rootTreeId);
    await this.manager.disposeTree(rootTreeId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const trees = [...this.knownTrees];
    this.knownTrees.clear();
    await Promise.allSettled(trees.map((t) => this.manager.disposeTree(t)));
    if (this.serverStarting && !this.server) {
      await this.serverStarting.catch(() => undefined);
    }
    if (this.server) {
      await this.server.close().catch(() => undefined);
      this.server = undefined;
    }
  }
}
