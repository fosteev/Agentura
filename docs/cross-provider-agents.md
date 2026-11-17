# Cross-Provider Managed Child Agents (`agentura_agents`)

Agentura lets a chat session on one engine spawn, monitor, steer, and stop managed child sessions on another engine through a single host-owned loopback MCP interface (`agentura_agents`), while rendering the full tree inside the `Agents` panel and `AgentsGraph` tab.

These are **host-managed sessions** built on Agentura's existing `AgentAdapter` / `AgentSession` layer — separate from each CLI's built-in native subagents (`Agent`, `spawn_agent`, etc.), which continue working independently and are never duplicated in the graph.

---

## Architecture

| Component | Module | Responsibility |
| --- | --- | --- |
| `ChildSessionManager` | `src/agent/children/manager.ts` | Owns lifecycle, policy enforcement, tree limits, idempotency, write ownership, transcripts, and restart recovery across existing `AgentAdapter`s. Zero `vscode` dependency. |
| `ChildAgentStore` | `src/agent/children/store.ts` | Atomic JSON persistence (`0o700` dir / `0o600` files) in `~/.local/share/agentura/child-agents` (`session-index.json` + per-tree SHA-256 JSON files). |
| `ChildAgentsMcpServer` | `src/agent/children/mcpServer.ts` | Loopback HTTP MCP server (`127.0.0.1:0`, `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`) exposing `agentura_agents` at `/mcp/<bindingToken>`. |
| `WriteOwnershipRegistry` & `GitWorktreeManager` | `src/agent/children/ownership.ts` | Prevents concurrent un-isolated shared-workspace writes (`WRITE_OWNERSHIP_CONFLICT`), resolves/validates context files strictly inside `cwd`, and manages `git worktree` isolation. |
| `validateChildPolicy`, `buildChildSessionOptions`, `decideChildPermission` | `src/agent/children/policy.ts` | Prevents privilege escalation (`POLICY_ESCALATION_DENIED`), rejects unsupported engine constraints (`POLICY_UNSUPPORTED_BY_ENGINE`), and resolves child permission/question/plan requests headlessly. |
| `createProviderRuntimes` | `src/agent/children/runtimes.ts` | Connects `claude`, `codex`, `kimi`, `antigravity`, `cursor`, `gemini`, and `zcode` adapters and real catalog/auth probes. |
| `ChildAgentsService` | `src/agent/children/host.ts` | Extension-host bridge wired into `ChatPanel` and `ChatController` for per-tab `SessionBinding`, live event forwarding, `agent.stop`/`agent.transcript`, resume replay, and tab teardown. |

---

## MCP Tool Contract (`agentura_agents`)

The MCP server binds every connection URL `/mcp/<bindingToken>` to a trusted `SessionBinding` (`rootTreeId`, `agentId`, `depth`, `cwd`, `maxAccess`, `allowBypassPermissions`). Caller-supplied `parent_id` in `agent_spawn` is rejected (`INVALID_ARGUMENTS`).

1. **`agents_catalog`**
   - Inspects available providers, real verified model lists (without fabricating model IDs), auth status (`ready | needs_auth | unavailable | unsupported`), supported access levels, fine-grained write-path / delegation capabilities, and remaining tree limits (`depth`, `maxDepth`, `activeRunning`, `maxConcurrentRunning`, `totalSpawns`, `maxTotalSpawns`).
2. **`agent_spawn`**
   - Non-blocking: validates provider/auth/model (no silent model substitution — rejects unlisted IDs with `UNKNOWN_MODEL`), effort, limits, policy, and explicit context (`task`, `context.notes`, `context.selectedText`, `context.files`; `fork_turns: "all"` rejects with `FORK_TURNS_UNSUPPORTED`), then returns `{ agent_id, status, provider, requested_model, effective_model, parent_id, root_id, depth, policy }`.
   - Supports `idempotency_key` scoped to `(callerBindingId, idempotency_key)`: identical retries return the same `agent_id` without spawning a second process; mismatched payloads fail with `IDEMPOTENCY_CONFLICT`.
   - Injects a fresh child `SessionBinding` MCP URL only when `policy.allowDelegate !== false`, `depth < maxDepth`, and the engine supports per-session HTTP MCP (`canDelegateViaMcp`).
3. **`agent_status`**
   - Returns `{ ...ChildStatusView }` for a single `agent_id`, or `{ agents: ChildStatusView[] }` for the caller's subtree.
4. **`agent_wait`**
   - Waits on `agent_id` or `agent_ids` up to `timeout_ms` (`100..120000`, default `30000`).
   - Returns `{ timed_out, agents }` without killing the child if still running.
   - **Wait-slot release:** while a managed child is blocked in `agent_wait`, its entry is added to `waitingCallers` so it does not consume a parallel execution slot needed for descendants.
5. **`agent_send`**
   - Sends a follow-up prompt (`message`, optional `context`, `idempotency_key`) to a non-running child in the caller's subtree, re-acquiring write ownership / concurrency slots and resuming the provider session if needed. Rejects `stopped` and `unknown_after_restart` nodes (`AGENT_NOT_SENDABLE`).
6. **`agent_stop`**
   - Recursively stops `agent_id` and all managed descendants (`interrupt()` + `dispose()`), releasing worktrees and write locks. Calling `agent_stop` again on an already terminal subtree safely returns `{ stopped_ids: [], already_terminal: true }`.

---

## Security, Ownership & Restart Semantics

- **Cross-tree isolation:** A session in root tree B receives `FORBIDDEN_FOREIGN_TREE` on `agent_status`, `agent_wait`, `agent_send`, or `agent_stop` targeting an agent in root tree A. Child sessions may only access themselves or their own descendants.
- **Policy ceiling:** Root bindings track the parent chat's permission mode (`plan` -> `read_only`, `bypassPermissions` -> `full_access`, otherwise `workspace_write`). `full_access` also requires `allowBypassPermissions: true`.
- **Headless child safety:** Child `question.request` and `plan.request` prompts are rejected instead of hanging for human UI input; `agentura_agents` tool calls obey `decideChildPermission`, and file/command requests follow `ChildPolicy`.
- **Shared vs. isolated writes:** Concurrent shared-workspace writes check normalized realpath prefix overlap in `WriteOwnershipRegistry` (`WRITE_OWNERSHIP_CONFLICT`). Engines whose non-interactive write mode cannot enforce narrow file-level `writePaths` reject narrow shared writes (`POLICY_UNSUPPORTED_BY_ENGINE`) and direct callers to use exclusive `writePaths: ["."]` or `isolation: "worktree"`.
- **Restart recovery:** On startup, `ChildAgentStore.loadAll()` restores finished children (`completed`, `failed`, `stopped`) with their saved prompt, model, summary, and transcript without re-executing tasks, while marking previously active (`starting`/`running`) nodes as `unknown_after_restart` and rejecting `agent_send`.

---

## UI & Graph Integration

- Managed child events emit `taskType: 'managed_agent'` with `provider` and `requestedModel` alongside `model` (`effectiveModel`).
- `Agents` tab, `AgentsGraph`, `hudState`, `agentsView`, and `agentViews` show provider, `requestedModel -> model`, prompt, status, summary, and per-node `Stop` / `Transcript`.
- `isManagedAgent` (`src/webview/hudState.ts`) enables individual `Stop` and `Transcript` actions on managed nodes even when the parent chat engine disables native subagent `agentStop` / `agentTranscript` flags (`providerFeatures`).
- Opening the `Agents` right-panel tab activates whenever either `features.value.subagents` is true OR `h.agents` contains a subagent/managed child (`src/webview/components/Chat.tsx`).

---

## Verification Matrix (Unit/Fixture vs. Live Runtime vs. UI/DOM)

Tests were executed on `2026-11-16` / `2026-11-17` against local CLI installations without mutating global CLI credentials (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.zcode`).

| Provider | Unit / Fixture | Live Runtime (Parent & Child via HTTP MCP) | UI / DOM (`vitest`) | Notes & Verified Blockers |
| --- | --- | --- | --- | --- |
| `codex` | Pass (`src/agent/codex/adapter.test.ts`, `src/agent/children/*`) | Pass (`Codex -> Kimi`, `Kimi -> Codex`, `Codex -> Kimi -> Codex`, `Codex -> Antigravity`, `Cursor -> Codex`) | Pass (`hudState`, `agentsView`, `agentViews`, `agentsGraphDom`, `chatController`) | Supports `hostMcpServers` in `thread/start` and `thread/resume`, parent & child verified live. |
| `kimi` | Pass (`src/agent/kimi/adapter.test.ts`, `src/agent/children/*`) | Pass (`Codex -> Kimi`, `Antigravity -> Kimi`, `Kimi -> Cursor`, nested `Codex -> Kimi -> Codex`) | Pass (`hudState`, `agentsView`, `agentViews`, `agentsGraphDom`, `chatController`) | Supports ACP HTTP `mcpServers`, parent & child verified live. |
| `antigravity` | Pass (`src/agent/antigravity/adapter.test.ts`, `src/agent/children/*`) | Pass (`Codex -> Antigravity`, `Antigravity -> Kimi` using `gemini-4-hydrogen-medium`) | Pass (`hudState`, `agentsView`, `agentViews`, `agentsGraphDom`, `settingsDom`) | Supports ACP HTTP `mcpServers` + `mcp_agentura_agents_*` auto-allow. |
| `cursor` | Pass (`src/agent/cursor/adapter.test.ts`, `src/agent/children/*`) | Pass (`Kimi -> Cursor`, `Cursor -> Codex` using `default[]`) | Pass (`hudState`, `agentsView`, `agentViews`, `agentsGraphDom`, `settingsDom`) | Supports ACP HTTP `mcpServers` in `session/new` and `session/load`. |
| `claude` | Pass (`src/agent/claude/adapter.test.ts`, `src/agent/children/*`) | **Blocked by local auth on test host:** `ClaudeAdapter` + MCP wiring reached `claude-haiku-5-5`, returned `"OAuth session expired and could not be refreshed"` (`AUTH_REQUIRED` / turn error). | Pass (`hudState`, `chatController`, `settingsDom`) | No local token refresh / relogin performed inside test run boundaries. |
| `gemini` | Pass (`src/agent/gemini/adapter.test.ts`, `src/agent/features.test.ts`) | **Live probe verified (`gemini 0.67.0`):** `agents_catalog` loads `auto`, `gemini-2.5-pro`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`; ACP `session/new` rejects with `-32000 IneligibleTierError` on `oauth-personal` without `GEMINI_API_KEY` / Vertex AI; `agent_spawn` returns `AUTH_REQUIRED`. | Pass (`settingsDom`, `protocol`, `manifest`, `settings`) | Native `--acp --skip-trust` adapter; never substituted with Antigravity. |
| `zcode` | Pass (`src/agent/zcode/adapter.test.ts`, `test/fixtures/zcode/*`, `src/agent/features.test.ts`) | **Live probe verified (`zcode 0.17.1`):** ZCode Protocol v1 NDJSON (non-`jsonrpc` envelope) discovers `agentura-zai-key/glm-5.3`; `provider/testModelConnectivity` reports `needs_auth` (`[1113] Insufficient balance` / `project_token_login_failed`) without touching `~/.zcode`; `canDelegateViaMcp: false` (`POLICY_UNSUPPORTED_BY_ENGINE` on `allowDelegate: true`). | Pass (`settingsDom`, `protocol`, `manifest`, `settings`) | Native `app-server --stdio`; `zcode` lacks per-session `mcpServers` injection without mutating `~/.zcode`, and is never substituted with Claude Code. |

### Verification Scripts
- `node scripts/cross-agents-codex-kimi-smoke.mjs` — live `Codex <-> Kimi` and nested `Codex -> Kimi -> Codex` (`depth 0 -> 1 -> 2`).
- `node scripts/cross-agents-matrix-smoke.mjs` — live matrix across `Codex`, `Kimi`, `Antigravity`, `Cursor`, `Claude`.
- `node scripts/gemini-zcode-probe.mjs` — live non-mutating `gemini 0.67.0` & `zcode 0.17.1` catalog, `AUTH_REQUIRED`, and `POLICY_UNSUPPORTED_BY_ENGINE` probe.
- `node scripts/cross-agents-errors-smoke.mjs` — 10-group HTTP MCP integration check covering `UNKNOWN_MODEL`, `AUTH_REQUIRED`, `POLICY_ESCALATION_DENIED`, `FORK_TURNS_UNSUPPORTED`, `POLICY_UNSUPPORTED_BY_ENGINE`, `PROVIDER_UNAVAILABLE` (crash & `spawnTimeoutMs`), bounded `agent_wait`, `idempotency_key` & `IDEMPOTENCY_CONFLICT`, tree limits & wait-slot release, `WRITE_OWNERSHIP_CONFLICT`, recursive/idempotent `agent_stop`, restart recovery (`unknown_after_restart`), and `FORBIDDEN_FOREIGN_TREE`.
