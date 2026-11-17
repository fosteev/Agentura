import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ChildSessionManager } from './manager';
import {
  CHILD_MCP_SERVER,
  ChildAgentError,
  type AgentSendArgs,
  type AgentSpawnArgs,
  type AgentStopArgs,
  type AgentWaitArgs,
} from './types';

const TOOLS_DEFINITIONS = [
  {
    name: 'agents_catalog',
    description: 'Inspect available engine providers, verified models, auth status and tree limits.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'agent_spawn',
    description: 'Spawn a managed child agent non-blockingly. Returns immediately with agent_id.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['provider', 'task'],
      properties: {
        provider: {
          type: 'string',
          description: "Target engine provider ('codex', 'kimi', 'claude', 'antigravity', 'cursor', etc.)",
        },
        task: {
          type: 'string',
          description: 'Self-contained task description for the child agent',
        },
        model: {
          type: 'string',
          description: 'Specific model from agents_catalog. Omit for provider default.',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Reasoning effort level',
        },
        title: {
          type: 'string',
          description: 'Short human-readable title',
        },
        idempotency_key: {
          type: 'string',
          description: 'Client idempotency key for safe retries',
        },
        fork_turns: {
          type: 'string',
          description: "Fork turns option (only 'none' supported; 'all' is rejected)",
        },
        context: {
          type: 'object',
          additionalProperties: false,
          properties: {
            selectedText: { type: 'string' },
            notes: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['path'],
                properties: {
                  path: { type: 'string' },
                  startLine: { type: 'integer' },
                  endLine: { type: 'integer' },
                },
              },
            },
          },
        },
        policy: {
          type: 'object',
          additionalProperties: false,
          properties: {
            access: { type: 'string', enum: ['read_only', 'workspace_write', 'full_access'] },
            isolation: { type: 'string', enum: ['shared', 'worktree'] },
            writePaths: { type: 'array', items: { type: 'string' } },
            allowDelegate: { type: 'boolean' },
          },
        },
      },
    },
  },
  {
    name: 'agent_status',
    description: "Check status of a specific agent or list all accessible agents in caller's subtree.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        agent_id: {
          type: 'string',
          description: 'Target agent ID. Omit to list all accessible agents.',
        },
      },
    },
  },
  {
    name: 'agent_wait',
    description: 'Wait for one or more agents to complete their current turn with a bounded timeout.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        agent_id: {
          type: 'string',
          description: 'Target agent ID to wait for',
        },
        agent_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of target agent IDs to wait for',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Wait timeout in milliseconds (100 to 120000, default 30000)',
        },
      },
    },
  },
  {
    name: 'agent_send',
    description: 'Send a follow-up instruction or clarification to an existing completed child agent.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['agent_id', 'message'],
      properties: {
        agent_id: {
          type: 'string',
          description: 'Target agent ID',
        },
        message: {
          type: 'string',
          description: 'Follow-up message or clarification',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional idempotency key',
        },
        context: {
          type: 'object',
          additionalProperties: false,
          properties: {
            selectedText: { type: 'string' },
            notes: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['path'],
                properties: {
                  path: { type: 'string' },
                  startLine: { type: 'integer' },
                  endLine: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'agent_stop',
    description: 'Recursively stop a child agent and all of its active descendants.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['agent_id'],
      properties: {
        agent_id: {
          type: 'string',
          description: 'Target agent ID to stop',
        },
      },
    },
  },
];

export class ChildAgentsMcpServer {
  private server?: HttpServer;
  private serverPort = 0;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly manager: ChildSessionManager) {}

  get port(): number {
    return this.serverPort;
  }

  urlForToken(token: string): string {
    return `http://127.0.0.1:${this.serverPort}/mcp/${token}`;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `Internal Server Error: ${String(err)}` }));
        }
      });
    });

    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.serverPort = addr.port;
          this.manager.setMcpUrlProvider((token) => this.urlForToken(token));
          resolve();
        } else {
          reject(new Error('Failed to obtain server address'));
        }
      });
      this.server?.on('error', reject);
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const parsedPath = rawUrl.split('?')[0] ?? '';

    if (!parsedPath.startsWith('/mcp/')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const token = parsedPath.slice('/mcp/'.length).trim();
    if (!token || !this.manager.getBinding(token)) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing binding token' }));
      return;
    }

    // Stateless MCP server instance per request
    const mcp = new Server(
      {
        name: CHILD_MCP_SERVER,
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOLS_DEFINITIONS,
      };
    });

    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

      try {
        let resultData: unknown;

        switch (toolName) {
          case 'agents_catalog': {
            resultData = await this.manager.catalog(token);
            break;
          }

          case 'agent_spawn': {
            if (rawArgs['parent_id'] !== undefined) {
              throw new ChildAgentError(
                'INVALID_ARGUMENTS',
                'parent_id is not allowed in tool arguments; caller identity is established by binding token',
              );
            }
            resultData = await this.manager.spawn(token, rawArgs as unknown as AgentSpawnArgs);
            break;
          }

          case 'agent_status': {
            resultData = await this.manager.status(token, rawArgs as { agent_id?: string });
            break;
          }

          case 'agent_wait': {
            resultData = await this.manager.wait(token, rawArgs as unknown as AgentWaitArgs);
            break;
          }

          case 'agent_send': {
            resultData = await this.manager.send(token, rawArgs as unknown as AgentSendArgs);
            break;
          }

          case 'agent_stop': {
            resultData = await this.manager.stop(token, rawArgs as unknown as AgentStopArgs);
            break;
          }

          default: {
            throw new ChildAgentError('INVALID_ARGUMENTS', `Unknown tool: ${toolName}`);
          }
        }

        const payload = Array.isArray(resultData)
          ? { ok: true, agents: resultData }
          : typeof resultData === 'object' && resultData !== null
            ? { ok: true, ...resultData }
            : { ok: true, data: resultData };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload),
            },
          ],
        };
      } catch (err) {
        if (err instanceof ChildAgentError) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  error: {
                    code: err.code,
                    message: err.message,
                    details: err.details,
                  },
                }),
              },
            ],
          };
        }

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: {
                  code: 'INVALID_ARGUMENTS',
                  message: String(err),
                },
              }),
            },
          ],
        };
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  async close(): Promise<void> {
    if (!this.server) return;

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = undefined;
    this.serverPort = 0;
  }
}
