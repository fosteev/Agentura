import type { AgentProvider } from './types';

/**
 * Что движок умеет, а что UI обязан спрятать (roadmap 15, этап 3). Приходит в `chat.info`; webview прячет по
 * флагам, а не по имени провайдера. Нет флагов в сообщении — Claude (все `true`).
 */
export interface ProviderFeatures {
  /** Режимы разрешений Claude (`ModeMenu`, shift-tab, `/plan`): у Codex политику задаёт его конфиг. */
  modes: boolean;
  /** `/compact` и кнопки «сжать». */
  compact: boolean;
  /** Заполнение контекстного окна (кольцо, полоса, счётчик): нужны настоящие `context.usage`. */
  context: boolean;
  /** Цена, кэш промпта, лимиты подписки (и блокировка отправки по лимиту): нет достоверных чисел — не рисовать. */
  cost: boolean;
  /** Субагенты: вкладка «агенты», карта, транскрипты. */
  subagents: boolean;
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
  /** «повторить» у сервера (`mcp.reconnect`): Claude (`reconnectMcpServer`). */
  mcpReconnect: boolean;
  /** «перезапустить все» (`mcp.reloadAll`): Codex (`mcpServer/reload`, по одному серверу не умеет). */
  mcpReloadAll: boolean;
  /** Скиллы движка известны (`skills` в init, вызовы `Skill`): раздел скиллов. Только Claude. */
  skills: boolean;
}

export const CLAUDE_FEATURES: Readonly<ProviderFeatures> = {
  modes: true,
  compact: true,
  context: true,
  cost: true,
  subagents: true,
  plan: true,
  questions: true,
  images: true,
  files: true,
  remote: true,
  mcp: true,
  mcpReconnect: true,
  mcpReloadAll: false,
  skills: true,
};

/**
 * Codex (app-server 0.160): режимов, compact и плана в нашем адаптере нет (no-op); субагенты маппятся из
 * `collabAgentToolCall`/`subAgentActivity`; вопросы агента
 * (`item/tool/requestUserInput`) приходят карточкой — `questions: true`;
 * контекст есть (настоящий `context.usage` из `thread/tokenUsage/updated`, без порогов и автосжатия), цены/кэша/лимитов нет
 * (`totalCostUsd: 0` = «неизвестно», лимитов подписки и cache TTL нет); `files` адаптер отбрасывает.
 * Картинки уходят data-URL'ом (на живом не проверено).
 */
export const CODEX_FEATURES: Readonly<ProviderFeatures> = {
  modes: false,
  compact: false,
  context: true,
  cost: false,
  subagents: true,
  plan: false,
  questions: true,
  images: true,
  files: false,
  remote: false,
  mcp: true,
  mcpReconnect: false,
  mcpReloadAll: true,
  skills: false,
};

/**
 * Antigravity (`agy`): режимы есть (4, `default` = авто-отказ без подтверждений по действию), compact, субагентов,
 * плана и вопросов нет; приборов нет (стоимость неизвестна, окна контекста и лимитов подписки Claude нет);
 * картинки и файлы адаптер отбрасывает (не проверены).
 */
export const ANTIGRAVITY_FEATURES: Readonly<ProviderFeatures> = {
  modes: true,
  compact: false,
  context: false,
  cost: false,
  subagents: false,
  plan: false,
  questions: false,
  images: false,
  files: false,
  remote: false,
  mcp: false,
  mcpReconnect: false,
  mcpReloadAll: false,
  skills: false,
};

export function providerFeatures(provider: AgentProvider): ProviderFeatures {
  return {
    ...(provider === 'codex' ? CODEX_FEATURES : provider === 'antigravity' ? ANTIGRAVITY_FEATURES : CLAUDE_FEATURES),
  };
}
