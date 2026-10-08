/**
 * Инструменты Jira для агента (roadmap 19, этап 8, решение 13), сторона хоста без vscode: есть ли они у чата (задача
 * вкладки, источник пишет, настройка `agentura.jira.agentTools`) и выполнение вызова через текущий источник. Движок
 * (Claude) оборачивает это в MCP-сервер `agentura_jira` (`src/agent/claude/jiraMcp.ts`).
 */
import { localDate } from '../../data/jira/client';
import { maybeSaved } from '../../data/jira/http';
import type { TransitionInfo } from '../../data/jira/types';
import type { TaskTools, TaskToolsSpec } from '../../agent/types';
import { eventLine, formatSeconds, JIRA_TOOLS, type AgentToolsSetting, type JiraToolName } from '../../shared/jiraTools';
import { parseTaskKey, type TaskKey } from '../taskGroups';
import { isIsoDate, MAX_COMMENT, MAX_WORK_COMMENT, normalizeIssueKey, type JiraSource } from './source';

/** Вызов источника ждём не дольше: повисший промис чужого расширения не должен держать ход агента. */
export const WRITE_TIMEOUT_MS = 60_000;
/** Сколько помнить неуверенную запись своего подключения (как `unsure` у Jiraffe API v2). */
export const UNSURE_MS = 10 * 60_000;

export interface AgentToolsDeps {
  /** Задача вкладки (группа сессии или ожидание) — `TaskTab.taskKey`. */
  taskKey(): TaskKey | undefined;
  sources: { forInstance(instanceId: string): JiraSource | undefined };
  settings(): AgentToolsSetting;
  /** Запись прошла — карточка задачи сразу (`TaskService.afterWrite`). */
  afterWrite(taskKey: TaskKey): Promise<void> | void;
  /** «Сегодня» для ворклога (локальная дата). */
  today?(): string;
  /** Токены этого чата — подставляются в `aiTokens` ворклога, если агент не передал своё число. */
  aiTokens?(): number | undefined;
}

/** Переход по словам агента: id, название перехода или целевого статуса (без регистра). */
export function pickTransition(list: readonly TransitionInfo[], to: string): TransitionInfo | undefined {
  const want = to.trim().toLowerCase();
  if (!want) return undefined;
  return (
    list.find((t) => t.id === to.trim()) ??
    list.find((t) => t.name.toLowerCase() === want) ??
    list.find((t) => t.to.name.toLowerCase() === want)
  );
}

/** Список переходов для текста ошибки модели: только выполнимые через API (без обязательных полей экрана). */
function describeTransitions(list: readonly TransitionInfo[]): string {
  const ok = list.filter((t) => !t.requiresFields);
  return ok.length ? ok.map((t) => `"${t.to.name}" (transition "${t.name}", id ${t.id})`).join('; ') : 'none';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

class ToolError extends Error {}
class WriteTimeout extends ToolError {}

export class AgentJiraTools implements TaskTools {
  private readonly listeners = new Set<() => void>();
  private sig = '';
  /** Своё подключение: запись того же вида в ту же задачу ещё идёт (Jiraffe API v2 сторожит это сам). */
  private readonly sending = new Set<string>();
  /**
   * Своё подключение: запись того же вида в ту же задачу оборвалась без ответа («могла сохраниться») — следующий такой вызов
   * один раз отклоняется (как у Jiraffe API v2): повтор агентом сразу после таймаута — частый дубль комментария/ворклога.
   */
  private readonly unsure = new Map<string, number>();

  constructor(private readonly deps: AgentToolsDeps) {
    this.sig = JSON.stringify(this.spec() ?? null);
  }

  /** Задача вкладки и источник с записью; нет — `undefined`. */
  private target(): { taskKey: TaskKey; instanceId: string; key: string; source: JiraSource } | undefined {
    const taskKey = this.deps.taskKey();
    const parsed = taskKey ? parseTaskKey(taskKey) : undefined;
    if (!taskKey || !parsed) return undefined;
    const source = this.deps.sources.forInstance(parsed.instanceId);
    if (!source?.writer) return undefined;
    return { taskKey, instanceId: parsed.instanceId, key: parsed.key, source };
  }

  spec(): TaskToolsSpec | undefined {
    const t = this.target();
    if (!t) return undefined;
    const on = this.deps.settings();
    const tools = JIRA_TOOLS.filter((n) => on[n]);
    if (!tools.length) return undefined;
    const instance = t.source.instances().find((i) => i.id === t.instanceId)?.name ?? t.instanceId;
    return { issue: t.key, instance, tools };
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Привязка, источник или настройка могли измениться: подписчики узнают, только если набор инструментов другой. */
  changed(): void {
    const sig = JSON.stringify(this.spec() ?? null);
    if (sig === this.sig) return;
    this.sig = sig;
    for (const l of [...this.listeners]) l();
  }

  async run(tool: JiraToolName, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    try {
      return { text: await this.exec(tool, args) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { text: `Error: ${msg.length > 1000 ? `${msg.slice(0, 1000)}…` : msg}`, isError: true };
    }
  }

  private async exec(tool: JiraToolName, args: Record<string, unknown>): Promise<string> {
    const t = this.target();
    if (!t) throw new ToolError('this chat is not attached to a Jira issue, or the Jira source cannot write');
    if (!(JIRA_TOOLS as readonly string[]).includes(tool) || !this.deps.settings()[tool]) {
      throw new ToolError(`the "${tool}" tool is turned off in Agentura settings (agentura.jira.agentTools)`);
    }
    const writer = t.source.writer;
    if (!writer) throw new ToolError('the Jira source cannot write');
    // другая задача — только на том же инстансе (ключ чужого инстанса здесь не отличить, поэтому инстанс всегда свой)
    const issueArg = args['issue'];
    const key = issueArg === undefined || issueArg === '' ? t.key : normalizeIssueKey(issueArg);
    const own = key === t.key;
    const lock = `${tool}:${key}`;
    const mine = t.source.kind === 'own';
    const release = (): void => void this.sending.delete(lock);
    if (mine) {
      if (this.sending.has(lock)) throw new ToolError(`a ${tool} for ${key} is already being sent; wait for it`);
      const at = this.unsure.get(lock);
      if (at !== undefined) {
        this.unsure.delete(lock);
        if (Date.now() - at < UNSURE_MS) {
          throw new ToolError(`the previous ${tool} for ${key} may have been saved; check the issue, then call again`);
        }
      }
      this.sending.add(lock);
    }
    const write = this.write(tool, args, t.instanceId, key, writer);
    // замок снимается, когда закончилась сама запись, а не наш таймаут: иначе повтор ушёл бы, пока первая ещё летит
    if (mine) void write.then(release, release);
    try {
      const text = await this.withTimeout(write);
      // карточка задачи чата — сразу, мимо окна 5 с и ручного режима
      if (own) void Promise.resolve(this.deps.afterWrite(t.taskKey)).catch(() => undefined);
      return text;
    } catch (e) {
      if (mine && e instanceof Error && (e.message.includes(maybeSaved()) || e instanceof WriteTimeout)) this.unsure.set(lock, Date.now());
      throw e;
    }
  }

  private async write(
    tool: JiraToolName,
    args: Record<string, unknown>,
    inst: string,
    key: string,
    writer: NonNullable<JiraSource['writer']>,
  ): Promise<string> {
    switch (tool) {
      case 'comment': {
        const text = str(args['text']);
        if (!text?.trim()) throw new ToolError('"text" is empty');
        if (text.length > MAX_COMMENT) throw new ToolError(`"text" is longer than ${MAX_COMMENT} characters`);
        const r = await writer.addComment(inst, key, text);
        return [`Comment added to ${key}${r.id ? ` (id ${r.id})` : ''}.`, eventLine(r.id ? `comment:${r.id}` : 'comment')].join('\n');
      }
      case 'transition': {
        const to = str(args['to'])?.trim();
        if (!to) throw new ToolError('"to" is empty');
        const list = await writer.transitions(inst, key);
        const t = pickTransition(list, to);
        if (!t) throw new ToolError(`no transition "${to.slice(0, 100)}" for ${key}. Available: ${describeTransitions(list)}`);
        if (t.requiresFields) {
          throw new ToolError(
            `transition "${t.name}" requires screen fields that the tool cannot fill; ask the user to do it in Jira. ` +
              `Available: ${describeTransitions(list)}`,
          );
        }
        await writer.transition(inst, key, t.id);
        return [`${key} moved to "${t.to.name}" (transition "${t.name}").`, eventLine('status')].join('\n');
      }
      case 'worklog': {
        const minutes = args['minutes'];
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          throw new ToolError('"minutes" must be an integer from 1 to 1440');
        }
        const today = this.deps.today?.() ?? localDate();
        const date = str(args['date'])?.trim() || today;
        if (!isIsoDate(date)) throw new ToolError(`"date" must be YYYY-MM-DD, got "${String(date).slice(0, 20)}"`);
        if (date > today) throw new ToolError(`"date" ${date} is in the future`);
        const comment = (str(args['comment']) ?? '').trim();
        if (comment.length > MAX_WORK_COMMENT) throw new ToolError(`"comment" is longer than ${MAX_WORK_COMMENT} characters`);
        const seconds = minutes * 60;
        const given = args['aiTokens'];
        if (given !== undefined && (typeof given !== 'number' || !Number.isInteger(given) || given < 0 || given > 1e12)) {
          throw new ToolError('"aiTokens" must be a non-negative integer');
        }
        const own = this.deps.aiTokens?.();
        const aiTokens = typeof given === 'number' ? given : own !== undefined && own > 0 ? Math.round(own) : undefined;
        const r = await writer.logWork(inst, key, { seconds, date, comment, ...(aiTokens !== undefined ? { aiTokens } : {}) });
        return [
          `Logged ${formatSeconds(seconds)} on ${key} for ${date}${r.id ? ` (worklog ${r.id})` : ''}.`,
          eventLine(r.id ? `worklog:${r.id}` : 'worklog'),
        ].join('\n');
      }
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let h: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      h = setTimeout(
        () => reject(new WriteTimeout(`no answer from Jira in ${WRITE_TIMEOUT_MS / 1000} s; the write may have been saved — check the issue before retrying`)),
        WRITE_TIMEOUT_MS,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(h));
  }
}
