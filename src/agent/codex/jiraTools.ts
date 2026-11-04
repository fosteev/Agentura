import type { AgentEvent, PermissionDecision, TaskTools, TaskToolsSpec } from '../types';
import { autoCommentOk, jiraMcpName, jiraToolOf, type JiraToolName } from '../../shared/jiraTools';
import type { DynamicToolSpec } from './protocol';

const signature = (s: TaskToolsSpec | undefined) => JSON.stringify(s ?? null);
const result = (text: string, success = false) => ({ contentItems: [{ type: 'inputText', text }], success });

/** Host-owned writes: approval policy of the model never bypasses this broker. */
export class CodexJiraTools {
  private built: TaskToolsSpec | undefined;
  private valid = false;
  private closed = false;
  private generation = 0;
  private unsubscribe: (() => void) | undefined;
  private readonly calls = new Map<string, Promise<ReturnType<typeof result>>>();
  get size(): number { return this.pending.size; }
  private readonly pending = new Map<string, (allow: boolean) => void>();
  private autoComments: number[] = [];
  constructor(private readonly tools: TaskTools | undefined, private readonly emit: (event: AgentEvent) => void,
    private readonly prefix: string) {}

  register(): DynamicToolSpec[] {
    this.built = this.tools?.spec();
    this.valid = !!this.built;
    this.unsubscribe = this.tools?.onDidChange(() => { this.valid = false; this.cancel(); });
    if (!this.built) return [];
    const issue = { type: 'string', maxLength: 50, description: `Default: ${this.built.issue}. Other keys must use the same Jira instance.` };
    return this.built.tools.map((name) => {
      const properties = name === 'comment' ? { text: { type: 'string', minLength: 1, maxLength: 32000 }, issue }
        : name === 'transition' ? { to: { type: 'string', minLength: 1, maxLength: 200 }, issue }
          : { minutes: { type: 'integer', minimum: 1, maximum: 1440 }, date: { type: 'string' }, comment: { type: 'string', maxLength: 30000 }, issue };
      return { type: 'function', name: jiraMcpName(name),
        description: `Jira ${name} for ${this.built!.issue} (${this.built!.instance}), as the user. Only write when requested. Comments use Jira wiki markup. Worklogs require an explicit user request.`,
        inputSchema: { type: 'object', properties, required: [name === 'comment' ? 'text' : name === 'transition' ? 'to' : 'minutes'], additionalProperties: false } };
    });
  }

  call(params: unknown, threadId: string, turnId: string | undefined): Promise<ReturnType<typeof result>> {
    if (!params || typeof params !== 'object') return Promise.resolve(result('Invalid tool request.'));
    const p = params as Record<string, unknown>;
    if (!threadId || !turnId || p['threadId'] !== threadId || p['turnId'] !== turnId ||
        typeof p['callId'] !== 'string' || (p['namespace'] !== null && p['namespace'] !== undefined)) {
      return Promise.resolve(result('Invalid or stale tool request.'));
    }
    const key = `${threadId}:${turnId}:${p['callId']}`;
    const existing = this.calls.get(key);
    if (existing) return existing;
    const promise = this.execute(key, p);
    this.calls.set(key, promise);
    return promise;
  }

  private current(name: JiraToolName): boolean {
    return !this.closed && this.valid && !!this.built?.tools.includes(name) &&
      signature(this.tools?.spec()) === signature(this.built);
  }

  private async execute(key: string, p: Record<string, unknown>): Promise<ReturnType<typeof result>> {
    const generation = this.generation;
    const name = typeof p['tool'] === 'string' ? jiraToolOf(p['tool']) : undefined;
    if (!name || !this.current(name)) return result('Jira tools are unavailable or changed. Start a new chat; nothing was written.');
    const raw = p['arguments'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result('Tool arguments must be an object.');
    const args = { ...raw } as Record<string, unknown>;
    // The model must not fabricate usage for restored history.
    delete args['aiTokens'];
    const issue = args['issue'];
    const own = issue === undefined || (typeof issue === 'string' && issue.trim().toUpperCase() === this.built!.issue.toUpperCase());
    const now = Date.now();
    this.autoComments = this.autoComments.filter((at) => now - at < 10 * 60_000);
    const automatic = name === 'comment' && own && autoCommentOk(args['text']) && this.autoComments.length < 3;
    if (automatic) this.autoComments.push(now);
    else {
      const id = `${this.prefix}${key}`;
      const allowed = await new Promise<boolean>((resolve) => {
        this.pending.set(id, resolve);
        this.emit({ type: 'permission.request', toolUseId: id, toolName: jiraMcpName(name), input: args,
          description: `Jira ${name}: ${typeof issue === 'string' ? issue : this.built!.issue} (${this.built!.instance})`, canAlwaysAllow: false });
      });
      if (!allowed) return result('Jira write denied or cancelled; nothing was written.');
    }
    if (generation !== this.generation || !this.current(name)) return result('Jira target or settings changed; nothing was written.');
    try {
      const r = await this.tools!.run(name, args);
      return result(r.text, !r.isError);
    } catch (error) { return result(`Jira write failed: ${error instanceof Error ? error.message : String(error)}. Do not retry blindly.`); }
  }

  respond(id: string, decision: PermissionDecision): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    const allow = decision === 'allow';
    this.emit({ type: 'permission.resolved', toolUseId: id, decision: allow ? 'allow' : 'deny', by: 'user' });
    resolve(allow);
    return true;
  }
  cancel(): void {
    this.generation++;
    for (const [id, resolve] of this.pending) {
      this.emit({ type: 'permission.resolved', toolUseId: id, decision: 'deny', by: 'abort' });
      resolve(false);
    }
    this.pending.clear();
  }
  close(): void { this.closed = true; this.cancel(); this.unsubscribe?.(); }
}
