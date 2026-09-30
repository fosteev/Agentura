/** Как карточки `.ask` выглядят (этап 5): подписи «всегда», разбор плана. Чистые функции. */
import type { PermissionAlways } from '../agent/types';
import { ui } from './strings';

export interface AlwaysButton {
  /** Текст кнопки до кода: «Всегда для». */
  label: string;
  /** Код в кнопке: `npm test`, папка. */
  code?: string;
  /** Подпись справа о месте записи. */
  hint: string;
}

/** Правило настроек → то, что показать в кнопке: `Bash(npm test:*)` → `npm test`. */
export function ruleSubject(rule: string): string {
  const m = /^([^(]+)\((.*)\)$/s.exec(rule);
  if (!m) return rule;
  const content = m[2]!.replace(/(:\*| \*|\*)$/, '').trim();
  return content || m[1]!;
}

/**
 * Кнопка «всегда» у разрешения не на правку: из правил движка (Bash → `.claude/settings.local.json`),
 * иначе папки на сессию. Режим `acceptEdits` как подсказка — у правок, там своя кнопка.
 */
export function alwaysButton(always: PermissionAlways | undefined): AlwaysButton | undefined {
  if (!always) return undefined;
  if (always.rules.length) {
    const first = ruleSubject(always.rules[0]!);
    const more = always.rules.length > 1 ? ` +${always.rules.length - 1}` : '';
    // «всегда» применяет все подсказки движка — папки на сессию тоже называем в подписи
    const dirs = always.directories.length
      ? ui.cards.plusDirs(always.directories[0]!, always.directories.length - 1)
      : '';
    const hint =
      (always.destination && always.destination !== 'session'
        ? ui.cards.alwaysHint(ui.cards.destination(always.destination))
        : ui.cards.sessionHint) + dirs;
    return { label: ui.cards.alwaysFor, code: first + more, hint };
  }
  if (always.directories.length) {
    return { label: ui.cards.alwaysDirs, code: always.directories[0]!, hint: ui.cards.sessionHint };
  }
  if (always.mode === 'acceptEdits') {
    return { label: ui.cards.acceptEditsSession, hint: ui.cards.editsHint };
  }
  return undefined;
}

export interface PlanView {
  title: string;
  /** Markdown без строки заголовка. */
  body: string;
  steps: number;
  files: { path: string; note?: string }[];
}

const FILES_HEADING = /файл|file/i;
const STEPS_HEADING = /шаг|step|план|plan|implement|изменени|change/i;

/**
 * Разбор плана (`ExitPlanMode.input.plan`, markdown целиком): заголовок — первый `# …`, шаги —
 * нумерованный список секции шагов (иначе все верхнеуровневые пункты `1.`), файлы — пункты секции
 * «Файлы»/«Files». Не угадали — карточка всё равно показывает markdown целиком.
 */
export function planView(md: string): PlanView {
  const lines = md.split('\n');
  let title: string = ui.cards.planTitle;
  const ti = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (ti >= 0) {
    title = lines[ti]!.replace(/^#\s+/, '').trim();
    lines.splice(ti, 1);
  }
  const body = lines.join('\n').trim();

  // секции по заголовкам ##/###
  const sections: { heading: string; lines: string[] }[] = [{ heading: '', lines: [] }];
  for (const l of lines) {
    const h = /^#{2,6}\s+(.*)$/.exec(l);
    if (h) sections.push({ heading: h[1]!.trim(), lines: [] });
    else sections[sections.length - 1]!.lines.push(l);
  }
  const ordered = (ls: string[]) => ls.filter((l) => /^\d+[.)]\s+\S/.test(l)).length;
  const stepSection = sections.find(
    (s) => STEPS_HEADING.test(s.heading) && !FILES_HEADING.test(s.heading) && ordered(s.lines) > 0,
  );
  const steps = stepSection
    ? ordered(stepSection.lines)
    : ordered(sections.filter((s) => !FILES_HEADING.test(s.heading)).flatMap((s) => s.lines));

  const files: PlanView['files'] = [];
  for (const s of sections) {
    if (!FILES_HEADING.test(s.heading)) continue;
    for (const l of s.lines) {
      const item = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(l);
      if (!item) continue;
      const text = item[1]!.replace(/\*\*/g, '').trim();
      const code = /`([^`]+)`/.exec(text);
      const path = (code ? code[1]! : text.split(/\s+[—–-]\s+/)[0]!).trim();
      if (!path) continue;
      const rest = code
        ? text.slice(text.indexOf(code[0]) + code[0].length)
        : text.slice(text.indexOf(path) + path.length);
      const note = rest.replace(/^[\s:—–-]+/, '').trim();
      files.push(note ? { path, note } : { path });
      if (files.length >= 12) break;
    }
  }
  return { title, body, steps, files };
}
