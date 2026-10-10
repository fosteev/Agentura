/**
 * Имя скилла от webview (`skill.open`, roadmap 21, решение 6): строчные буквы, цифры, `:`, `_`, `-`. Ни точек, ни
 * слэшей — путь из имени не выйдет за папку скиллов.
 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

export function isSkillName(v: unknown): v is string {
  return typeof v === 'string' && SKILL_NAME_RE.test(v);
}

/** Папка скилла: у плагинного (`plugin:skill`) — часть после последнего `:` (решение 5); пусто — `undefined`. */
export function skillDirName(name: string): string | undefined {
  if (!isSkillName(name)) return undefined;
  const dir = name.slice(name.lastIndexOf(':') + 1);
  return dir || undefined;
}
