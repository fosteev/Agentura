import { realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { skillDirName } from '../shared/skills';

/**
 * SKILL.md скилла (roadmap 21, решение 6): сначала `<cwd>/.claude/skills/<имя>/SKILL.md`, потом то же в домашней
 * папке. Имя проверяется (`SKILL_NAME_RE`), у плагинного берётся часть после `:`. Нет файла (встроенный скилл,
 * плагин со своей папкой) или имя кривое — `undefined`.
 */
export async function findSkillFile(
  name: string,
  cwd: string,
  home: string,
  isFile: (path: string) => Promise<boolean> = fileExists,
): Promise<string | undefined> {
  const dir = skillDirName(name);
  if (!dir) return undefined;
  for (const root of [cwd, home]) {
    if (!root) continue;
    const path = join(root, '.claude', 'skills', dir, 'SKILL.md');
    if (await isFile(path)) return path;
  }
  return undefined;
}

/**
 * Обычный файл. Симлинки разрешены (свои скиллы часто — ссылки на папку в dotfiles), но цель должна сама
 * называться `SKILL.md`: чужой репозиторий не подсунет ссылкой `.claude/skills/x/SKILL.md → ~/.ssh/id_rsa`.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    return basename(await realpath(path)) === 'SKILL.md';
  } catch {
    return false;
  }
}
