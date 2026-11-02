/**
 * Браузерный MCP-сервер (roadmap 27): Playwright MCP в режиме `--extension` управляет настоящим Chrome пользователя через
 * расширение Playwright MCP Bridge. Один набор для Claude и Codex; Antigravity MCP не умеет (`features.browser`).
 */
export const BROWSER_SERVER = 'browser';
export const BROWSER_COMMAND = 'npx';
export const BROWSER_ARGS = ['-y', '@playwright/mcp@latest', '--extension'];
