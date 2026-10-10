import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findSkillFile } from './skillFiles';
import { isSkillName, skillDirName } from '../shared/skills';

describe('имя скилла (roadmap 21, решение 6)', () => {
  it('допустимы строчные, цифры, : _ -; точки, слэши, пустое и длинное — нет', () => {
    for (const ok of ['plan', 'roadmap-run', 'pohuy:pohuy', 'a_b', 'x1']) expect(isSkillName(ok)).toBe(true);
    for (const bad of ['', '../x', '..', 'a/b', 'a\\b', '.hidden', 'Plan', '-x', 'a b', 'x'.repeat(65), 5, undefined])
      expect(isSkillName(bad)).toBe(false);
  });
  it('папка плагинного — после последнего двоеточия', () => {
    expect(skillDirName('pohuy:pohuy')).toBe('pohuy');
    expect(skillDirName('plan')).toBe('plan');
    expect(skillDirName('a:')).toBeUndefined();
    expect(skillDirName('../x')).toBeUndefined();
  });
});

describe('findSkillFile', () => {
  let root: string;
  let cwd: string;
  let home: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-'));
    cwd = join(root, 'proj');
    home = join(root, 'home');
    for (const [base, name] of [
      [cwd, 'both'],
      [home, 'both'],
      [home, 'mine'],
    ] as const) {
      await mkdir(join(base, '.claude', 'skills', name), { recursive: true });
      await writeFile(join(base, '.claude', 'skills', name, 'SKILL.md'), `# ${name}`);
    }
    // папка без SKILL.md
    await mkdir(join(cwd, '.claude', 'skills', 'empty'), { recursive: true });
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('сначала проект, потом домашняя папка; плагинный — по части после :', async () => {
    expect(await findSkillFile('both', cwd, home)).toBe(join(cwd, '.claude', 'skills', 'both', 'SKILL.md'));
    expect(await findSkillFile('mine', cwd, home)).toBe(join(home, '.claude', 'skills', 'mine', 'SKILL.md'));
    expect(await findSkillFile('plug:mine', cwd, home)).toBe(join(home, '.claude', 'skills', 'mine', 'SKILL.md'));
  });

  it('нет файла или кривое имя — undefined, файловую систему не трогает', async () => {
    expect(await findSkillFile('empty', cwd, home)).toBeUndefined();
    expect(await findSkillFile('builtin', cwd, home)).toBeUndefined();
    const seen: string[] = [];
    const spy = async (p: string) => (seen.push(p), true);
    expect(await findSkillFile('../both', cwd, home, spy)).toBeUndefined();
    expect(await findSkillFile('', cwd, home, spy)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('SKILL.md-симлинк: на другой SKILL.md (или папка-ссылка) — да, на произвольный файл — нет', async () => {
    const secret = join(root, 'id_rsa');
    await writeFile(secret, 'secret');
    await mkdir(join(cwd, '.claude', 'skills', 'evil'), { recursive: true });
    await symlink(secret, join(cwd, '.claude', 'skills', 'evil', 'SKILL.md'));
    expect(await findSkillFile('evil', cwd, home)).toBeUndefined();
    await symlink(join(home, '.claude', 'skills', 'mine'), join(cwd, '.claude', 'skills', 'linked'));
    expect(await findSkillFile('linked', cwd, home)).toBe(join(cwd, '.claude', 'skills', 'linked', 'SKILL.md'));
  });
});
