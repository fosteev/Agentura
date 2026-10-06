/** Логика поля ввода без DOM: триггеры меню «/» и «@», фильтры, история. */
import type { CommandOption } from '../agent/types';

export interface Trigger {
  kind: 'slash' | 'at';
  /** Набранное после символа. */
  query: string;
  /** Позиция символа-триггера в тексте. */
  start: number;
}

/**
 * Меню «/» — только если текст начинается с `/` и до каретки нет пробелов. Меню «@» — `@` в начале
 * слова (после пробела/перевода строки/начала), до каретки в слове нет пробелов.
 */
export function detectTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  if (/^\/[^\s]*$/.test(before)) return { kind: 'slash', query: before.slice(1), start: 0 };
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (m) return { kind: 'at', query: m[1] ?? '', start: before.length - (m[1]?.length ?? 0) - 1 };
  return undefined;
}

/** Подставляет выбранное вместо набранного токена; возвращает текст и позицию каретки. */
export function applyCompletion(
  text: string,
  caret: number,
  trigger: Trigger,
  insert: string,
): { text: string; caret: number } {
  const tail = text.slice(caret);
  const head = text.slice(0, trigger.start);
  const token = `${trigger.kind === 'slash' ? '/' : '@'}${insert} `;
  const rest = tail.startsWith(' ') ? tail.slice(1) : tail;
  return { text: `${head}${token}${rest}`, caret: head.length + token.length };
}

export interface SlashItem {
  name: string;
  description: string;
  group: 'command' | 'skill';
  own: boolean;
}

/** Собственные команды расширения: обрабатываются в webview/хосте, не уходят движку. */
export const OWN_COMMANDS = ['plan', 'compact', 'clear', 'status', 'rc', 'remote-control'] as const;

/**
 * Собственные команды, доступные движку: `/plan` — режим (`modes`), `/compact` — сжатие (`compact`),
 * `/rc` и `/remote-control` — Remote Control (`remote`, только Claude).
 */
export function ownCommands(f: { modes: boolean; compact: boolean; remote?: boolean }): string[] {
  return OWN_COMMANDS.filter((n) =>
    n === 'plan'
      ? f.modes
      : n === 'compact'
        ? f.compact
        : n === 'rc' || n === 'remote-control'
          ? !!f.remote
          : true,
  );
}

/**
 * Список меню «/»: свои команды, затем команды движка (`supportedCommands()` и `init.slash_commands`)
 * и скиллы (`init.skills`). Дубли по имени схлопываются: свои команды важнее.
 */
export function buildSlashItems(
  engine: readonly CommandOption[],
  slashCommands: readonly string[],
  skills: readonly string[],
  ownDescriptions: Readonly<Record<string, string>>,
  own: readonly string[] = OWN_COMMANDS,
): SlashItem[] {
  const skillSet = new Set(skills);
  const described = new Map(engine.map((c) => [c.name, c.description]));
  const seen = new Set<string>();
  const out: SlashItem[] = [];
  for (const name of own) {
    seen.add(name);
    out.push({ name, description: ownDescriptions[name] ?? '', group: 'command', own: true });
  }
  const names = [...engine.map((c) => c.name), ...slashCommands, ...skills];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: described.get(name) ?? '',
      group: skillSet.has(name) ? 'skill' : 'command',
      own: false,
    });
  }
  return out;
}

/** Фильтр по набранному: сначала по префиксу, затем по вхождению; порядок внутри групп сохраняется. */
export function filterSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  if (!q) return [...items];
  const prefix = items.filter((i) => i.name.toLowerCase().startsWith(q));
  const inside = items.filter(
    (i) => !i.name.toLowerCase().startsWith(q) && i.name.toLowerCase().includes(q),
  );
  return [...prefix, ...inside];
}

/** Шаг по истории (↑ = -1 старше, ↓ = +1 новее). `index` — позиция в истории; `undefined` — не листаем. */
export function historyStep(
  length: number,
  index: number | undefined,
  dir: -1 | 1,
): number | undefined {
  if (length === 0) return undefined;
  if (index === undefined) return dir === -1 ? length - 1 : undefined;
  const next = index + dir;
  if (next < 0) return 0;
  if (next >= length) return undefined;
  return next;
}

/** Добавить в историю: пустое и повтор последнего не пишем. */
export function pushHistory(history: readonly string[], text: string, max = 100): string[] {
  const t = text.trim();
  if (!t || history[history.length - 1] === t) return [...history];
  return [...history, t].slice(-max);
}
