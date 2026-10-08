/**
 * Инструменты задачи Jira для Claude (roadmap 19, этап 8, решение 13): in-process MCP-сервер `agentura_jira` через SDK
 * (`createSdkMcpServer` + `tool`, схемы — zod из того же пакета, что у SDK). Сам вызов выполняет хост (`TaskTools.run`):
 * здесь только описание инструментов для модели и обёртка результата в `CallToolResult`.
 */
import type {
  createSdkMcpServer as sdkCreateSdkMcpServer,
  McpSdkServerConfigWithInstance,
  tool as sdkTool,
} from '@anthropic-ai/claude-agent-sdk';
import type { z as zod } from 'zod';
import type { TaskTools, TaskToolsSpec } from '../types';
import { JIRA_MCP_SERVER, jiraMcpName } from '../../shared/jiraTools';

/** Что нужно для сервера: две функции SDK и zod (грузятся динамически вместе с SDK). */
export interface McpKit {
  createSdkMcpServer: typeof sdkCreateSdkMcpServer;
  tool: typeof sdkTool;
  z: typeof zod;
}

export const JIRA_SERVER = JIRA_MCP_SERVER;
/** `comment` к задаче чата — без вопроса (решение 13); остальное — карточкой разрешения. */
export const JIRA_COMMENT_TOOL = jiraMcpName('comment');

/** Набор, ради которого сервер пересобирается: задача, инстанс и включённые инструменты. */
export function specSignature(spec: TaskToolsSpec | undefined): string {
  return spec ? JSON.stringify([spec.issue, spec.instance, [...spec.tools].sort()]) : '';
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const result = (text: string, isError?: boolean): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Вызов хоста не бросает в движок: исключение — текст ошибки модели. Чат перепривязали к другой задаче, пока висела карточка
 * разрешения (`built` — задача, под которую собран сервер), — отказ: без `issue` запись ушла бы не в ту задачу, что одобрена.
 */
async function call(
  tools: TaskTools,
  name: 'comment' | 'transition' | 'worklog',
  args: Record<string, unknown>,
  built: string,
): Promise<ToolResult> {
  const now = tools.spec()?.issue;
  if (now !== built) {
    return result(`Error: this chat is now attached to ${now ?? 'no issue'} instead of ${built}; nothing was written. Call again if still needed.`, true);
  }
  try {
    const r = await tools.run(name, args);
    return result(r.text, r.isError);
  } catch (e) {
    return result(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

export function buildJiraServer(
  kit: McpKit,
  spec: TaskToolsSpec,
  tools: TaskTools,
): McpSdkServerConfigWithInstance {
  const { z } = kit;
  const issue = z
    .string()
    .max(50)
    .optional()
    .describe(
      `Issue key. Default: ${spec.issue} (the task of this chat). Another key must be on the same Jira instance.`,
    );
  const defs = [];
  if (spec.tools.includes('comment')) {
    defs.push(
      kit.tool(
        'comment',
        `Add a comment to the Jira issue ${spec.issue} as the user. The text is Jira wiki markup (h3. heading, *bold*, ` +
          `{{code}}, {code}…{code}, "* " bullets) — not Markdown. Use it for results, questions to people and status notes ` +
          `the user asked for; do not comment on every step.`,
        {
          text: z.string().min(1).max(32_000).describe('Comment body, Jira wiki markup.'),
          issue,
        },
        (args) => call(tools, 'comment', args, spec.issue),
        {
          annotations: {
            title: 'Jira: comment',
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
          alwaysLoad: true,
        },
      ),
    );
  }
  if (spec.tools.includes('transition')) {
    defs.push(
      kit.tool(
        'transition',
        `Move the Jira issue ${spec.issue} to another status (a workflow transition) as the user. The user is asked for ` +
          `permission. "to" is the target status name, the transition name or its id; if it does not match, the error ` +
          `lists the available transitions. Transitions that require screen fields are not supported.`,
        {
          to: z
            .string()
            .min(1)
            .max(200)
            .describe('Target status name, transition name or transition id.'),
          issue,
        },
        (args) => call(tools, 'transition', args, spec.issue),
        {
          annotations: {
            title: 'Jira: change status',
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
          alwaysLoad: true,
        },
      ),
    );
  }
  if (spec.tools.includes('worklog')) {
    defs.push(
      kit.tool(
        'worklog',
        `Log work time on the Jira issue ${spec.issue} as the user (Jira worklog, or Tempo through Jiraffe). The user is ` +
          `asked for permission. Log only when the user asked for it.`,
        {
          minutes: z.number().int().min(1).max(1440).describe('Time spent, minutes (1–1440).'),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe('Day of the work, YYYY-MM-DD in local time. Default: today.'),
          comment: z.string().max(30_000).optional().describe('What was done (plain text).'),
          issue,
        },
        (args) => call(tools, 'worklog', args, spec.issue),
        {
          annotations: {
            title: 'Jira: log work',
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
          alwaysLoad: true,
        },
      ),
    );
  }
  return kit.createSdkMcpServer({
    name: JIRA_SERVER,
    version: '1.0.0',
    instructions:
      `This chat is attached to the Jira issue ${spec.issue} (${spec.instance}). The jira tools write to it as the user; ` +
      `the user sees every change in the task panel. Without "issue" they act on ${spec.issue}.`,
    tools: defs,
    alwaysLoad: true,
  });
}
