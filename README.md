# Agentura

**English** · [Русский](README.ru.md)

Claude chat for VS Code that shows what Claude Code keeps out of sight: context in tokens, cost per turn, cache,
subscription limits, which subagents are running and what they edited. It runs on the Claude Agent SDK, the same
engine as Claude Code, through your installed `claude` and its login. Codex CLI is available as a second engine
(see [Codex](#codex)).

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.png">
  <img alt="Sidebar with limits and sessions, chat tab with a finished turn and the changes panel" src="docs/images/hero-dark.png">
</picture>

Personal project, not on the Marketplace. Install it from a `.vsix` (see [Install](#install)).

## Features

- **Two engines.** Claude (default) or Codex, picked per tab in the "agent" menu under the input box.
- **Chat in editor tabs.** One session per tab. `Cmd/Ctrl+Alt+A` opens a chat, `Cmd/Ctrl+Shift+N` starts a new
  session.
- **Gauges by the input box.** Context with yellow and orange thresholds, cost and tokens per turn, cache TTL and hit
  rate, 5-hour and 7-day limits.
- **Permissions.** Tool approval, agent questions and plan review (`ExitPlanMode`) are cards in the feed. Edits open
  in the native diff.
- **Sidebar.** The project's sessions: search, resume, rename. Account and limits are shown above the list.
- **Right panel.**
  - `changes` lists files the session touched.
  - `git` is a working tree view where you stage, commit and push. Files the agent edited are marked.
  - `agents` shows the turn's subagents.
- **Agents graph.** Opens in its own editor tab: who started whom, the prompt each agent got and the summary it
  returned, plus its live calls.
- **Attachments.** Paste screenshots with `⌘V`. Attach files with "+" or by dragging them in with `⇧` held. Text and PDF are sent as documents.
- **Look.** Four feed styles, six input layouts, five agent views, three git layouts, three session list densities, your own fonts
  (bundled, installed or Google Fonts), separate text sizes for the feed and the rest of the interface.
- **English and Russian interface.**

### Feed styles

`agentura.feed.style`: `journal`, `folded`, `replies`, `cards`.

![Four feed styles of the same turn](docs/images/feed-styles.png)

### Input layouts

`agentura.composer.layout`: `classic`, `card`, `statusline`, `gauges`, `minimal`, `shell`. Keys and behavior are the
same in all of them; only the arrangement changes. While a turn runs the field shows "↵ queue" and a stop button.

![Six input layouts](docs/images/composer-layouts.png)

### Agents

`agentura.agents.view`: `list`, `tree`, `lanes`, `cards`. With `graph` the agent map opens in an editor tab.

![Agent panel views: list, tree, lanes, cards](docs/images/agents-views.png)

![Agents graph in an editor tab](docs/images/agents-graph.png)

### Git tab

`agentura.git.layout` controls the layout when the workspace has several repositories:

- `stack` gives each repository its own section.
- `picker` puts the repository list on top.
- `unified` shows one list and makes one commit across the repositories you tick.

The ✦ button asks Sonnet to write the commit message from the staged diff.

![Git tab layouts: stack, picker, unified](docs/images/git-layouts.png)

### Sidebar and settings

`agentura.sessionList.view`: `detailed`, `compact`, `dense`. All settings are also on a settings tab (⚙ in the sidebar),
with live previews.

![Session list views](docs/images/session-list.png)

![Settings tab, Appearance page](docs/images/settings-look.png)

## Install

You need:

- VS Code 1.100 or newer.
- Claude Code 2.1.285 or newer, installed and logged in (`claude`, then `/login`).
- Optional, for the Codex engine: Codex CLI, installed and logged in (`codex login`).

The extension does not ship the engine binary (200+ MB). It finds the system `claude` in `PATH`, `~/.local/bin`,
`~/.claude/local` or Homebrew (on Windows it looks for `claude.exe`). To point it somewhere else, set `agentura.claudeExecutable`.

```
code --install-extension agentura-0.5.0.vsix
```

To build from source:

```
npm ci
npm run check      # types, lint, unit tests, build
npm run package    # agentura-0.5.0.vsix
```

## Codex

Pick Codex in the "agent" menu of an empty tab, or set `agentura.defaultProvider` (the menu writes it, so the next new
tab opens on the same engine). A tab keeps its engine for the whole session. Agentura starts `codex app-server` per
tab and talks to it over stdio, the same way it runs `claude`. Approval policy and sandbox come from your
`~/.codex/config.toml`; Agentura does not override them.

Supported: streaming replies, Stop, the model and effort pickers, command, file-change and permission approvals,
agent questions, images in a message, tool rows and the `changes` tab, the context size next to the input box (after the
first turn: until Codex reports its window, there is no gauge), and session history: the sidebar lists the recent
Codex threads of the project folder, up to 500 (including ones started in the Codex CLI),
and you can resume and rename them. When `codex` is installed, the sidebar starts a short `codex app-server` to read
that list (at most every 30 seconds); a thread started in the CLI shows up on the next refresh.

Not in this version (hidden in the interface, not faked):

- Permission modes, plan review, `/compact` and the agents tab. Codex has no equivalents in the app-server protocol
  Agentura uses.
- Cost, cache and subscription limits: Codex does not report them. The context gauge has no thresholds or
  auto-compact marks for the same reason.
- File attachments (text and PDF). Images are sent.
- Restored Codex history has no per-turn token counts, and a thread row in the sidebar shows no turns or cost.
- "Always" on a command approval writes a permanent rule to `~/.codex/rules`; the card says so.
- An edit shows in the `changes` tab and the diff as the changed fragment, not as a whole-file before/after.

The app-server protocol is marked experimental by Codex. Agentura is checked against `codex-cli 0.160.0`; newer
versions usually work, but see [docs/codex-protocol.md](docs/codex-protocol.md) before updating.

## Antigravity engine (experimental)

A chat tab can also run on Google's Antigravity CLI (`agy`): pick it in the engine menu of an empty tab, or set
`agentura.defaultProvider` to `antigravity`. Models inside `agy` include Gemini, Claude and GPT.

You need `agy` installed and signed in (run `agy` once in a terminal). Agentura finds it in `PATH`, `~/.local/bin` or
Homebrew; `agentura.antigravityExecutable` points elsewhere (⚙ → "Engine" has a check button). The weekly quota
(`agy -p "/usage"`, at most once per 10 minutes) shows by the input box instead of the Claude limits; if the output
can't be parsed, nothing is shown.

What differs from Claude:

- `agy` cannot ask for approval per action. In the default mode it denies what needs permission and the feed shows an
  "agy declined: …" card with "Allow edits and retry" / "Allow everything and retry". Stronger modes restart the
  process; `bypassPermissions` only through an explicit choice and `agentura.allowBypassPermissions`.
- Stop kills the `agy` process; the next message restarts it with the same conversation.
- No plan review, agent questions, `/compact`, subagents, context window, cache or cost gauges; images and files are
  not sent.
- Conversation history is read from `agy`'s local storage (`~/.gemini/antigravity-cli`), an internal format that may
  change; if it does, history degrades to what was seen live. Conversations of the open folder appear in the sidebar
  and on the empty screen with an engine label (resume and rename work; without `agy` they are simply absent).

## Settings

Everything is under `agentura.*`. You can change it in the Settings UI or on the settings tab. These settings are read from
user settings only, so a cloned repository can't change them through its `.vscode/settings.json`:

| Setting                           | Default  | Meaning                                          |
| --------------------------------- | -------- | ------------------------------------------------ |
| `agentura.claudeExecutable`       | empty    | Path to `claude`; empty means auto-detect        |
| `agentura.codexExecutable`        | empty    | Path to `codex`; empty means auto-detect         |
| `agentura.antigravityExecutable`  | empty    | Path to `agy`; empty means auto-detect           |
| `agentura.defaultProvider`        | `claude` | Engine for new tabs: `claude`, `codex` or `antigravity`        |
| `agentura.allowBypassPermissions` | `false`  | Allow the `bypassPermissions` mode (Claude only) |

If `agentura.defaultPermissionMode` is set to `bypassPermissions` while bypass is not allowed, new sessions start in
`manual` mode.

## Known limitations

- **Login and ToS.** Anthropic does not allow third-party products to offer claude.ai login without approval.
  Agentura has no login of its own and uses the CLI's login. That is fine for personal use, but publishing it would need either approval or API keys.
- **Limits** come from an undocumented endpoint (`/api/oauth/usage`) and may break. If they do, the extension falls
  back to the engine's `rate_limit_event`, which doesn't say which window the limit belongs to.
- **Transcripts** (`~/.claude/projects/*.jsonl`) use an internal format. Session totals are parsed from them and can
  drift after a CLI update.
- **Codex** support is new and was tried on macOS arm64 only. The model list comes from your Codex account
  (`model/list` when the session starts).
- **Cost** is an estimate. Your subscription bill is the source of truth.
- **Each chat tab runs its own `claude` (or `codex app-server`) process.**
- **Subagents** have no separate cost or token counts because the engine does not report them. Prompt and summary sizes are
  estimated from text length.
- **Tested only on macOS arm64.** CI runs on macOS and Ubuntu, but nobody has used it by hand on Windows or Linux.

## Development

```
npm run watch              # rebuild extension and webviews
npm test                   # unit tests (vitest)
npm run test:integration   # integration test in a downloaded VS Code
node scripts/vsix-verify.mjs [--live]    # check the built .vsix; --live runs one Haiku turn
node scripts/readme-shots/run.mjs        # re-render the screenshots above (needs npm run build)
```

Where things are:

- `src/agent` is the SDK adapter.
- `src/data` covers sessions, limits and prices.
- `src/extension` is the extension host.
- `src/webview` is the Preact UI.
- `prototype/` is the reference markup.

`Agentura: Show State (debug)` opens state fixtures without the engine. The `scripts/*-smoke.mjs` scripts run the live engine
and spend tokens. The plan and decision log are in `docs/roadmap/` (in Russian).

## License

[MIT](LICENSE)
