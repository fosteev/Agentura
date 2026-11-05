import type { AgentProvider } from './types';

/**
 * Что движок умеет, а что UI обязан спрятать (roadmap 15, этап 3). Приходит в `chat.info`; webview прячет по
 * флагам, а не по имени провайдера. Нет флагов в сообщении — возможности Claude.
 */
export interface ProviderFeatures {
  /** Claude/Antigravity permission modes; native Codex controls use nativeSettings. */
  modes: boolean;
  /** Native Codex collaboration and session policies, separate from Claude modes/cards. */
  nativeSettings: boolean;
  /** `/compact` и кнопки «сжать». */
  compact: boolean;
  /** Claude context thresholds/auto-compaction hints, independent of manual compact. */
  autoCompact: boolean;
  /** Заполнение контекстного окна (кольцо, полоса, счётчик): нужны настоящие `context.usage`. */
  context: boolean;
  /** Цена, кэш промпта, лимиты подписки (и блокировка отправки по лимиту): нет достоверных чисел — не рисовать. */
  cost: boolean;
  /** Субагенты: вкладка «агенты», карта, транскрипты. */
  subagents: boolean;
  agentStop: boolean;
  agentTranscript: boolean;
  /** Карточка плана (`ExitPlanMode`). */
  plan: boolean;
  /** Вопросы агента (`AskUserQuestion`). */
  questions: boolean;
  /** Картинки в сообщении. */
  images: boolean;
  /** Файлы (pdf/текст) как `document`-блоки. */
  files: boolean;
  /** Remote Control (roadmap 17): кнопка «rc», `/rc` — сессия на claude.ai и в телефоне. Только Claude. */
  remote: boolean;
  /**
   * MCP (roadmap 21): движок сообщает статус серверов (`mcp.status`); нет — кнопка «mcp», вкладка «mcp» и
   * системная строка скрыты. Claude и Codex.
   */
  mcp: boolean;
  /** Браузер агента (roadmap 27, `agentura.browser.enabled`): MCP-сервер `browser`. Claude и Codex. */
  browser: boolean;
  /** «повторить» у сервера (`mcp.reconnect`): Claude (`reconnectMcpServer`). */
  mcpReconnect: boolean;
  /** «перезапустить все» (`mcp.reloadAll`): Codex (`mcpServer/reload`, по одному серверу не умеет). */
  mcpReloadAll: boolean;
  /** Тумблер вкл/выкл сервера (`mcp.toggle`): для текущей папки у Claude и Codex. */
  mcpToggle: boolean;
  /** Скиллы движка известны (`skills` в init, вызовы `Skill`): раздел скиллов. Только Claude. */
  skills: boolean;
}

export const CLAUDE_FEATURES: Readonly<ProviderFeatures> = {
  nativeSettings: false,
  modes: true,
  compact: true,
  autoCompact: true,
  context: true,
  cost: true,
  subagents: true,
  agentStop: true,
  agentTranscript: true,
  plan: true,
  questions: true,
  images: true,
  files: true,
  remote: true,
  browser: true,
  mcp: true,
  mcpReconnect: true,
  mcpReloadAll: false,
  mcpToggle: true,
  skills: true,
};

/**
 * Codex (app-server 0.166): native planning/policies отдельны от Claude plan approvals; ручной compact поддержан; субагенты маппятся из
 * `collabAgentToolCall`/`subAgentActivity`; вопросы агента
 * (`item/tool/requestUserInput`) приходят карточкой — `questions: true`;
 * контекст есть (настоящий `context.usage` из `thread/tokenUsage/updated`, без порогов и автосжатия), цены/кэша/лимитов нет
 * (`totalCostUsd: 0` = «неизвестно», лимитов подписки и cache TTL нет); `files` адаптер отбрасывает.
 * Картинки уходят data-URL'ом (на живом не проверено).
 */
export const CODEX_FEATURES: Readonly<ProviderFeatures> = {
  nativeSettings: true,
  modes: false,
  compact: true,
  autoCompact: false,
  context: true,
  cost: false,
  subagents: true,
  agentStop: false,
  agentTranscript: false,
  plan: false,
  questions: true,
  images: true,
  files: false,
  remote: false,
  browser: true,
  mcp: true,
  mcpReconnect: false,
  mcpReloadAll: true,
  mcpToggle: true,
  skills: true,
};

/**
 * Antigravity (`agy`): режимы есть (4, `default` = авто-отказ без подтверждений по действию), compact, субагентов,
 * плана и вопросов нет; приборов нет (стоимость неизвестна, окна контекста и лимитов подписки Claude нет);
 * картинки и файлы адаптер отбрасывает (не проверены).
 */
export const ANTIGRAVITY_FEATURES: Readonly<ProviderFeatures> = {
  nativeSettings: false,
  modes: true,
  compact: false,
  autoCompact: false,
  context: false,
  cost: false,
  subagents: false,
  agentStop: false,
  agentTranscript: false,
  plan: false,
  questions: false,
  images: false,
  files: false,
  remote: false,
  browser: false,
  mcp: false,
  mcpReconnect: false,
  mcpReloadAll: false,
  mcpToggle: false,
  skills: false,
};

/**
 * Cursor (`agent acp`): режимы есть (`session/set_mode`). `questions` false —
 * `cursor/ask_question` спайк не видел, метод отвечает `skipped`. `plan` true: карточка
 * `cursor/create_plan` есть. `sessionUpdate: plan` с entries в ленту не идёт.
 * Цены, контекста и картинок в кадрах не было.
 */
export const CURSOR_FEATURES: Readonly<ProviderFeatures> = {
  nativeSettings: false,
  modes: true,
  compact: false,
  autoCompact: false,
  context: false,
  cost: false,
  subagents: false,
  agentStop: false,
  agentTranscript: false,
  plan: true,
  questions: false,
  images: false,
  files: false,
  remote: false,
  browser: false,
  mcp: false,
  mcpReconnect: false,
  mcpReloadAll: false,
  mcpToggle: false,
  skills: false,
};

export function providerFeatures(provider: AgentProvider): ProviderFeatures {
  return {
    ...(provider === 'codex'
      ? CODEX_FEATURES
      : provider === 'antigravity'
        ? ANTIGRAVITY_FEATURES
        : provider === 'cursor'
          ? CURSOR_FEATURES
          : CLAUDE_FEATURES),
  };
}
