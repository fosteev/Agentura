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
  /** Приборы: контекст, кэш, лимиты подписки, стоимость. Нет достоверных чисел — не рисовать. */
  metrics: boolean;
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
}

export const CLAUDE_FEATURES: Readonly<ProviderFeatures> = {
  modes: true,
  compact: true,
  metrics: true,
  subagents: true,
  plan: true,
  questions: true,
  images: true,
  files: true,
};

/**
 * Codex (app-server 0.160): режимов, compact, субагентов и плана в нашем адаптере нет (no-op); вопросы агента
 * (`item/tool/requestUserInput`) приходят карточкой — `questions: true`;
 * приборов нет (`totalCostUsd: 0` = «неизвестно», лимитов подписки и cache TTL нет); `files` адаптер отбрасывает.
 * Картинки уходят data-URL'ом (на живом не проверено).
 */
export const CODEX_FEATURES: Readonly<ProviderFeatures> = {
  modes: false,
  compact: false,
  metrics: false,
  subagents: false,
  plan: false,
  questions: true,
  images: true,
  files: false,
};

/**
 * Antigravity (`agy`): режимы есть (4, `default` = авто-отказ без подтверждений по действию), compact, субагентов,
 * плана и вопросов нет; приборов нет (стоимость неизвестна, окна контекста и лимитов подписки Claude нет);
 * картинки и файлы адаптер отбрасывает (не проверены).
 */
export const ANTIGRAVITY_FEATURES: Readonly<ProviderFeatures> = {
  modes: true,
  compact: false,
  metrics: false,
  subagents: false,
  plan: false,
  questions: false,
  images: false,
  files: false,
};

export function providerFeatures(provider: AgentProvider): ProviderFeatures {
  return {
    ...(provider === 'codex' ? CODEX_FEATURES : provider === 'antigravity' ? ANTIGRAVITY_FEATURES : CLAUDE_FEATURES),
  };
}
