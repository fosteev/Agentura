import type { JSX } from 'preact';
import type { AgentProvider } from '../../agent/types';

export type BrandIconProps = JSX.IntrinsicElements['span'] & {
  provider: AgentProvider | string;
};

/**
 * Брендовый SVG-логотип движка (roadmap 42).
 * Стили заданы в media/hud.css (.sidebar .brand, .brand-claude, .brand-codex и т.д.).
 */
export function BrandIcon({ provider, class: className, ...props }: BrandIconProps) {
  const cls = ['brand', `brand-${provider}`, className].filter(Boolean).join(' ');
  return <span class={cls} aria-hidden="true" {...props} />;
}
