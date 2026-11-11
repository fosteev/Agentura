import type { AgentProvider } from '../agent/types';
import type { SessionSummary } from '../protocol';
import type { TaskPickerAction, TaskPickerError, TaskPickerResult } from '../shared/taskPicker';
import { issueContext } from '../data/jira/text';
import type { JiraSources } from './jira/source';
import { canonicalBaseUrl, parseIssueInput } from './taskLink';
import { taskKeyOf, taskSessionRows, type TaskGroups, type TaskMeta } from './taskGroups';

export interface TaskPickerDeps {
  sources: Pick<JiraSources, 'allInstances' | 'forInstance' | 'refresh'>;
  groups: Pick<TaskGroups, 'group'>;
  sessions(): Promise<SessionSummary[]>;
  archived(id: string): boolean;
  hasOpen(taskKey: string): boolean;
  open(taskKey: string, chat?: { id: string; provider: AgentProvider }): boolean;
  create(
    meta: TaskMeta,
    context: string,
    provider: AgentProvider,
    prompt?: string,
  ): Promise<boolean>;
}

/** One sidebar lookup: the context stays on the host; actions refer only to the latest successful lookup. */
export class TaskPicker {
  private generation = 0;
  private snapshot?: { requestId: number; taskKey: string; meta: TaskMeta; context: string };
  private acting = false;
  constructor(
    private readonly deps: TaskPickerDeps,
    private readonly timeoutMs = 20_000,
  ) {}

  cancel(): void {
    this.generation++;
    this.snapshot = undefined;
  }

  async find(requestId: number, query: string, instanceId?: string): Promise<TaskPickerResult> {
    this.cancel();
    const generation = this.generation;
    const parsed = parseIssueInput(query);
    if (!parsed || parsed.kind === 'taskKey') return { kind: 'error', code: 'invalid' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async (): Promise<TaskPickerResult> => {
      await this.deps.sources.refresh();
      const instances = this.deps.sources.allInstances();
      const available =
        parsed.kind === 'link'
          ? instances.filter(
              (i) =>
                canonicalBaseUrl(i.baseUrl) === parsed.baseUrl &&
                (!instanceId || i.id === instanceId),
            )
          : instanceId
            ? instances.filter((i) => i.id === instanceId)
            : instances;
      if (!available.length) return { kind: 'error', code: 'no-source' };
      if (available.length > 1)
        return {
          kind: 'instances',
          instances: available.map(({ id, name, baseUrl }) => ({ id, name, baseUrl })),
        };
      const instance = available[0]!;
      const source = this.deps.sources.forInstance(instance.id);
      if (!source) return { kind: 'error', code: 'no-source' };
      const { issue } = await source.issue(instance.id, parsed.key);
      const taskKey = taskKeyOf(instance.id, parsed.key);
      const rows = await this.deps.sessions();
      const chats = taskSessionRows(this.deps.groups.group(taskKey), rows).map((c) => ({
        id: c.id,
        provider: c.provider,
        title: c.title,
        updatedAt: c.updatedAt,
        archived: this.deps.archived(c.id),
      }));
      const meta: TaskMeta = {
        key: parsed.key,
        instanceId: instance.id,
        title: issue.summary,
        status: issue.status,
        statusCategory: issue.statusCategory,
        url: `${instance.baseUrl.replace(/\/+$/, '')}/browse/${parsed.key}`,
      };
      if (generation !== this.generation) return { kind: 'error', code: 'stale' };
      const attachments = issue.attachments
        .slice(0, 100)
        .map((a) => `- ${a.filename}: ${a.contentUrl}`)
        .join('\n');
      const context =
        issueContext({ instanceName: instance.name, issue }, meta.url) +
        (attachments ? `\n## Attachments\n\n${attachments}\n` : '');
      this.snapshot = { requestId, taskKey, meta, context };
      return {
        kind: 'found',
        taskKey,
        key: meta.key,
        title: meta.title,
        status: meta.status,
        instance: { id: instance.id, name: instance.name, baseUrl: instance.baseUrl },
        chats,
        existing: chats.length > 0 || this.deps.hasOpen(taskKey),
      };
    };
    try {
      return await Promise.race([
        work(),
        new Promise<TaskPickerResult>((resolve) => {
          timer = setTimeout(() => {
            if (generation === this.generation) this.cancel();
            resolve({ kind: 'error', code: 'timeout' });
          }, this.timeoutMs);
        }),
      ]);
    } catch {
      return { kind: 'error', code: 'unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async act(action: TaskPickerAction): Promise<TaskPickerError | undefined> {
    const snapshot = this.snapshot;
    if (this.acting || !snapshot || snapshot.requestId !== action.requestId) return 'stale';
    this.acting = true;
    try {
      if (action.mode === 'create') {
        if (!action.provider) return 'invalid';
        if (
          !(await this.deps.create(snapshot.meta, snapshot.context, action.provider, action.prompt))
        )
          return 'failed';
      } else {
        // Re-read membership: a stale/malicious session id must never open a chat from another task.
        const rows = await this.deps.sessions();
        const chats = taskSessionRows(this.deps.groups.group(snapshot.taskKey), rows);
        if (this.snapshot !== snapshot) return 'stale';
        const chat = action.sessionId
          ? chats.find((c) => c.id === action.sessionId && c.provider === action.provider)
          : chats[0];
        if (action.sessionId && !chat) return 'stale';
        if (!chat && !this.deps.hasOpen(snapshot.taskKey)) return 'stale';
        if (!this.deps.open(snapshot.taskKey, chat)) return 'failed';
      }
      if (this.snapshot === snapshot) this.cancel();
      return undefined;
    } catch {
      return 'failed';
    } finally {
      this.acting = false;
    }
  }
}
