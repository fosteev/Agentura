import type { ComponentChildren } from 'preact';
import { tabStep } from '../a11y';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  disabled?: boolean;
  /** Бейдж справа от подписи: `live` — идёт ход / живые агенты. */
  badge?: { text: string; live: boolean };
}

/**
 * Вкладки `role=tablist` со стрелками ←/→/Home/End: общие для шапки узкого режима и для панели
 * справа. `idPrefix` даёт id вкладок (`tab-turn`, `ptab-turn`), `aria-controls` — на панели `pane-<key>`.
 */
export function TabBar<K extends string>({
  items,
  active,
  onSelect,
  idPrefix,
  ariaLabel,
  class: cls,
  tag: Wrap = 'div',
  children,
}: {
  items: readonly TabItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  idPrefix: string;
  ariaLabel: string;
  class: string;
  tag?: 'nav' | 'div';
  /** Дополнительное содержимое после вкладок (кнопка «скрыть» панели). */
  children?: ComponentChildren;
}) {
  return (
    <Wrap
      class={cls}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(e: KeyboardEvent) => {
        // стрелки только на самих вкладках: на кнопке «скрыть» они ничего не листают
        if (!(e.target as HTMLElement).closest('[role=tab]')) return;
        const next = tabStep(
          e.key,
          items.findIndex((i) => i.key === active),
          items.map((i) => !i.disabled),
        );
        if (next === undefined) return;
        e.preventDefault();
        onSelect(items[next]!.key);
        const list = e.currentTarget as HTMLElement | null;
        requestAnimationFrame(() => {
          list?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
        });
      }}
    >
      {items.map((i) => (
        <button
          role="tab"
          id={`${idPrefix}-${i.key}`}
          aria-controls={`pane-${i.key}`}
          aria-selected={active === i.key}
          tabIndex={active === i.key ? 0 : -1}
          disabled={i.disabled}
          onClick={() => onSelect(i.key)}
        >
          {i.label}
          {i.badge && <span class={i.badge.live ? 'b live' : 'b'}>{i.badge.text}</span>}
        </button>
      ))}
      {children}
    </Wrap>
  );
}
