# Agentura

**English** · [Русский](README.ru.md)

A VS Code extension: a Claude chat plus the gauges that stock clients hide — context in tokens, cost per turn,
cache, subscription limits, an agent map. Powered by the Claude Agent SDK (the same engine as Claude Code).

Version 0.2.0 is a personal release and is not published to the Marketplace.

## Features

- Chat in an editor tab (`Agentura: Open Chat`, `Cmd/Ctrl+Alt+A`), multiple tabs — one session per tab.
- Gauges: context gauge (configurable thresholds), cost and tokens per turn, cache (TTL timer and hit rate), 5 h / 7 d limits.
- Tool permissions, agent questions, plan (`ExitPlanMode`), native diff for edits.
- Sidebar: the project's session list, resume, rename, account and limits.
- Settings tab: ⚙ in the sidebar (or `Agentura: Settings`) — model, mode and effort for new sessions,
  context thresholds, limits polling period, path to `claude` with a check.
- Screenshots: `⌘V` / `Ctrl+V` in the input field pastes an image from the clipboard (up to 10 per message, downscaled
  to 1568 px), thumbnails in the feed and history, a click opens the image in a tab.
- File attachments: "+" → "Image or file…", or drag from the VS Code explorer and tabs **while holding ⇧**
  (without it VS Code does not hand the drop to the extension). Text (UTF-8, up to 256 KB) and pdf (up to 100 pages)
  are sent as documents; attachments are counted per session — 100 pdf pages, 24 MB and 70 % of the context window.
  A dropped folder becomes a reference, like "File or folder…".
- Agents: parallel subagents grouped as `×N`, an agent map (turn, prompt, result, tokens, time), "stop all",
  a subagent's transcript as a separate document.
- States: turn running, waiting for reply, engine errors, rate limit. When a limit is hit, sending is held until the
  reset; there is no automatic resend (A14 — after 0.1).
- Interface in English and Russian (`agentura.language`).

## Requirements

- VS Code 1.138 or newer.
- Claude Code (`claude`) 2.1.285 or newer, installed and logged in (`claude` → `/login`).
  The extension does not bundle the engine binary (it is 200+ MB) and runs the system `claude`:
  it looks in `PATH`, `~/.local/bin`, `~/.claude/local`, Homebrew (on Windows — `claude.exe`, also in
  `%APPDATA%\npm`; the npm wrapper `claude.cmd` won't do — the SDK starts the engine without a shell). The lookup is
  asynchronous and runs ahead of time when the window starts. If found, it checks `claude --version`, logs a version
  below 2.1.285 and warns. If not found, the engine does not start and the feed shows a "Claude Code not found" card
  with "Open settings" and "Check again" buttons (no window reload needed).
- No Node required: the extension runs on the Node bundled with VS Code.

## Installing from `.vsix`

```
code --install-extension agentura-0.2.0.vsix
```

or in VS Code: Extensions → `…` → "Install from VSIX…". Building the package from source:

```
npm ci
npm run check          # types, linter, unit tests, build
npm run package        # agentura-0.2.0.vsix in the repo root
```

## Settings

| Setting                           | Default            | What it does                                                                  |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `agentura.claudeExecutable`       | empty              | Path to `claude`; empty — look for the system one ¹                           |
| `agentura.defaultModel`           | empty              | Model for new sessions (empty — engine default)                               |
| `agentura.defaultPermissionMode`  | `manual`           | Mode for new sessions: `manual`, `acceptEdits`, `plan`, `bypassPermissions` ¹ |
| `agentura.defaultEffort`          | empty              | Effort for new sessions: `low` … `max` (empty — engine default)               |
| `agentura.contextThresholds`      | `[120000, 150000]` | Yellow and orange zones of the context gauge, in tokens                       |
| `agentura.allowBypassPermissions` | `false`            | Allow the `bypassPermissions` mode ¹                                          |
| `agentura.usagePollMinutes`       | `15`               | Subscription limits polling period, minutes (at least 5)                      |
| `agentura.limits.readKeychain`    | `true`             | Read the Claude Code token from the macOS Keychain to request limits          |
| `agentura.sessionList.view`       | `compact`          | List view: `detailed`, `compact`, `dense` (button in the "Sessions" header)   |
| `agentura.sessionList.context`    | `true`             | Session context column (`173k ctx`) in the list                               |
| `agentura.sessionList.time`       | `true`             | Last activity time column in the list                                         |
| `agentura.sidebar.top`            | `detailed`         | Sidebar top view: `detailed`, `compact`, `dense` (account and limits)         |
| `agentura.language`               | `auto`             | Interface language: `auto` (same as VS Code), `ru`, `en`; after a reload      |

¹ User settings only: the value from a workspace `.vscode/settings.json` is ignored, so that someone else's
repository can't swap the executable or turn on running without confirmations.

## Known limitations

- **Subscription login and ToS.** The SDK documentation does not allow third-party products to offer claude.ai login
  without Anthropic's approval. The extension is for personal use: it has no login of its own and works through the
  installed CLI's login. Public distribution needs either permission or an API key as the primary path.
- **5 h / 7 d limits** come from the undocumented `GET /api/oauth/usage` with the Claude Code token
  (Keychain on macOS or `~/.claude/.credentials.json`). It may break; the fallback is the engine's
  `rate_limit_event`, which has no window type.
- **The transcript format** `~/.claude/projects/*.jsonl` is internal and changes between CLI versions; session totals
  (tokens, cost) are computed by parsing transcripts, the list and history go through the SDK.
- **Cost is an estimate** (`total_cost_usd` plus our own price table); the subscription bill may differ.
- **Memory.** Every chat tab holds its own `claude` process. After a window reload, background tabs start the engine
  only when first shown. Processes are closed when the extension is deactivated.
- **The session list** rereads the active transcript in full (at most every 4 s): very long sessions may stutter.
- The package is universal (no native code) but has been tested only on macOS arm64: Windows and Linux haven't been
  tested by hand. CI runs `npm run check` on macOS and ubuntu and the integration test on ubuntu.
- Agents have no separate cost and tokens — the engine does not report them.
- "Retry turn" avoids duplicating the prompt only if the interrupted turn changed nothing (reads and searches); after
  edits or commands the session is resumed in full, and the prompt appears twice in the transcript.

## For developers

```
npm run watch              # rebuild extension and webview
npm test                   # unit tests (vitest)
npm run test:integration   # integration test in VS Code (@vscode/test-electron, downloads VS Code)
node scripts/vsix-verify.mjs [--live]   # check the built .vsix: contents, loading, SDK; --live — one Haiku turn
```

The `Agentura: Show State (debug)` command opens a tab with state fixtures, no engine needed.
Live engine checks are `scripts/*-smoke.mjs` (they spend tokens, see the script headers).

Layout: `src/agent` — agent adapter, `src/data` — sessions, limits, prices, `src/extension` — host,
`src/webview` — Preact UI, `prototype/` — the reference markup. The plan and decision history (in Russian) are in
`docs/roadmap/`.
