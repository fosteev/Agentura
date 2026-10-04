# Changelog

## Unreleased

### Added

- **Chat tab**: the Agentura icon instead of the default one; the title is just the session name (no
  "Agentura ·" prefix, up to 40 characters with "…"), "New session" until it has a name. The ● / ? / ! state marker
  stays. A "New session" button with the logo sits in the right corner of the tab bar, visible above any editor.
- **Session list view**: three views in the sidebar — `detailed` (two lines per session), `compact` (default: one
  line, two for the current, running, waiting-for-reply and failed sessions) and `dense` (everything on one line).
  Switched with the ☰ / ≡ / ≣ button in the "Sessions" header and in ⚙ → "Sidebar"; context (`173k ctx`) and time
  columns on the right, each can be turned off. If the view is set in workspace settings, the button shows a
  notification instead of changing it. New settings: `agentura.sessionList.view`, `agentura.sessionList.context`,
  `agentura.sessionList.time`.
- **Sidebar**: the "Account and limits" and "Sessions" sections collapse on a header click (or Enter), and the state
  survives a view reload. Search by session name works: filters as you type, case-insensitive, "ё" = "е"; ✕ or Esc
  clears it.
- **Sidebar top view** (`agentura.sidebar.top`, ⚙ → "Sidebar"): `detailed` — as before; `compact` — the account and
  each limit on one line (gauge, percentage, reset time), "New session" as a ＋ button in the "Sessions" header;
  `dense` — limits as mini-gauges in the panel header next to ↻ and ⚙ (yellow above 70 %, red above 85 %), the
  account in the header tooltip.
- **Settings tab sections are pages**: a section list on the left (arrow keys switch too; a tab strip above the page
  in a narrow split) instead of anchors on one long page; the open section is remembered. Six sections regrouped into
  five: New session, Context and limits, Sidebar, Appearance, Engine.
- **Fonts and feed text size** (⚙ → "Appearance"): `agentura.font.interface` and `agentura.font.code` set the panel and
  monospace fonts (empty — VS Code's interface and editor fonts, which are also the fallback if the font is not
  installed); `agentura.feed.fontSize` (10–20 px, default 13) scales the whole chat feed. Open tabs, the sidebar and
  settings update immediately.
- **English interface** (`agentura.language`, ⚙ → "Appearance"): `auto` (default — Russian if VS Code is in Russian,
  English otherwise), `ru`, `en`. Applies after a window reload (notification with a button). Command titles and
  setting descriptions in the Settings UI follow VS Code's own language (`package.nls*.json`).
- **Tooltips** on every button in the chat, sidebar and settings instead of the native `title`: VS Code hover widget
  colors, after 0.5 s (neighbors — instantly), above the button near the bottom edge, the second line dimmed, keys as
  badges (`Enter`, `Esc`, `⌘⇧N`); shown on Tab focus too, hidden on Esc, click, scroll.

## 0.2.0 — 2026-10-01

Personal release, not published to the Marketplace.

### Added

- **Settings tab** (⚙ in the sidebar, `Agentura: Settings` command): model and effort for new sessions, mode for
  new sessions (`agentura.defaultPermissionMode`: `manual` | `acceptEdits` | `plan` | `bypassPermissions`, the last
  one only with `allowBypassPermissions`), context thresholds, limits polling period, Keychain reading, path to
  `claude` with a "check" button. Writes to user settings; if workspace settings override them, the tab shows it.
  New settings: `agentura.defaultPermissionMode`, `agentura.defaultEffort`.
- **Screenshots in a message**: paste from the clipboard (⌘V / Ctrl+V), drag and drop, and "Image or file…" under
  "+". Images are downscaled to 1568 pixels on the longer side, up to 10 per message; thumbnails in the feed and
  history, a click opens the image in an editor tab.
- **File attachments**: text (up to 256 KB, UTF-8) and pdf (up to 100 pages) are sent as documents, shown in the feed
  and history as a chip with the path. Dragging from the VS Code explorer and tabs requires holding ⇧ (without it
  VS Code does not pass the drop to the webview); a dropped folder becomes a reference chip, like "File or folder…".
  Attachments are counted per session: at most 100 pdf pages, 24 MB and 70 % of the context window; whatever fits
  goes into the request.
- **Multiple agents**: consecutive subagent calls are collected into one `×N` group with totals; an agent map (turn,
  prompt, result, tokens, time, model of the selected one); "stop all" stops all running subagents (Esc — the whole
  turn); a subagent's transcript opens as a document. The "agents" badge shows `running / total`. No per-agent
  cost: the engine does not report it.
- **Non-blocking `claude` lookup**: asynchronous, warmed up on activation, with a per-candidate timeout; on Windows
  it looks for `claude.exe` (the SDK can't run the npm wrapper `claude.cmd` — a hint to install the native
  `claude.exe` is shown instead). "Check" in the settings tab is asynchronous too.
- **Clear behavior without `claude`**: the engine does not start; the feed shows a "Claude Code not found" card with
  instructions, an "Open settings" and a "Check again" button (no window reload). Replaces the SDK error about a
  missing binary.
- Claude Code artifacts: the engine starts with the `Artifact` tool enabled; a call is shown in the feed as a card
  with a status (created / updated · vN / published) and an "open" link to claude.ai.
- HTML preview: a "preview" link on written and edited `.html` files and on artifacts opens the file in a side tab
  and redraws it when the file changes.
- A "threshold crossed" line in the feed when the context gauge enters the yellow or orange zone.
- CI on GitHub Actions: `npm run check` on macOS and ubuntu, the integration test in VS Code under `xvfb-run`
  (ubuntu), building and verifying the `.vsix`.

### Changed

- Sticking feeds to the bottom moved into a shared hook; the right "turn / agents" panel stretches to full height;
  the "state" button is removed from the header (the command and `/status` remain).
- The session list and history read transcripts as a stream from a saved offset: on a 50 MB transcript a list tick
  takes ~8 ms instead of ~360 ms, and the host thread is not blocked. A manually set session name no longer
  disappears when the list refreshes.
- "Always" in a permission card covers every place the rule is written to (`.claude/settings.local.json`,
  `~/.claude/settings.json`); a relative `file_path` from the model is resolved against the session folder.
- An edit you approved is saved automatically; the preview is built from the editor's unsaved text.
- "Retry turn" after an interruption does not duplicate the prompt if the interrupted turn changed nothing (only reads
  and searches); if it had edits or commands, the session is resumed in full and the prompt will appear twice in the
  transcript. An SDK refusal to drop the turn is caught, and the retry goes without dropping. The "retrying…" status
  clears after 20 seconds.
- Images and pdfs from `Read` results are no longer duplicated in the webview as a base64 copy.
- The `Agentura: Show State (debug)` command is visible only when running from source.

### Fixed

- A wake-up turn (background task notification) no longer removes a message from the queue; background tasks are
  not marked "stopped" when the webview is reseeded between turns; Esc in the middle of subagent work no longer
  leaves them "running".
- The host no longer cuts attachments by the context window until the engine has reported it (after a resume the
  window may be 1M).
- `usagePollMinutes` is capped at 1440: larger values made `setTimeout` fire after 1 ms and polling ran without a
  pause.

### Security

- `agentura.defaultPermissionMode` is read only from user settings (scope `machine`), like `claudeExecutable` and
  `allowBypassPermissions`: someone else's repository can't make new sessions start in `acceptEdits`.
  `bypassPermissions` is not written while `allowBypassPermissions` is off.
- The host re-validates dropped and picked files itself: type by content, strict base64, regular files only (no FIFOs
  or devices), size limits before reading; encrypted and truncated pdfs are rejected. A dropped file is read from any
  path (owner's decision), the same as the "+" dialog.

### Requirements and limitations

- Unchanged (Claude Code 2.1.285+ logged in, subscription ToS, undocumented `/api/oauth/usage`).
- The `.vsix` is universal (~5.5 MB) without the engine binary; tested only on macOS arm64. Windows and Linux haven't
  been tested by hand.
- No limit on live tabs: each holds its own `claude` process.
- Agents have no tokens "in the main context" and no cost; "continue the conversation" with an agent is not
  supported.

## 0.1.0 — 2026-10-01

First release (personal, not published to the Marketplace).

### Added

- Claude chat in an editor tab on Claude Agent SDK 0.3.285: streaming response, thinking, tools, message queue,
  stopping a turn (`Esc`), `@file` references and the editor selection in context.
- Gauges: context gauge (20 blocks, configurable thresholds), cache (TTL timer and hit rate), 5 h / 7 d limits, turn
  summary (tokens, cache, cost, duration), "turn" and "agents" panels (subagent tree, stopping background tasks),
  system lines (compaction, mode change).
- Tool permissions, agent questions, plan (`ExitPlanMode`) and a native diff for edits; `default` / `acceptEdits` /
  `plan` modes, `bypassPermissions` only via a setting.
- Sessions: a sidebar with the project's list, resume, rename, multiple tabs (one session per tab), restoring tabs
  after a window reload, account and limits.
- States and errors: turn not started, engine error with "Retry", rate limit with a countdown to the reset.
- Commands: `Agentura: Open Chat`, `New Session`, `Open Last Session`, `Resume Session`, `Refresh Limits`,
  `Show Log`, `Show State (debug)`.
- `.vsix` packaging (universal, ~5.5 MB) and an integration test on `@vscode/test-electron`.

### Requirements and limitations

- Requires Claude Code 2.1.285+ installed and logged in: the engine binary (200+ MB) is not bundled; the extension
  looks for the system `claude` (PATH, `~/.local/bin`, Homebrew) or takes the path from `agentura.claudeExecutable`
  and checks the version.
- `agentura.claudeExecutable` and `agentura.allowBypassPermissions` are read only from user settings (scope
  `machine`): workspace settings don't override them.
- Subscription login through the CLI is a ToS restriction for public distribution (see README).
- 5 h / 7 d limits come from the undocumented `/api/oauth/usage`; the transcript format is internal.
