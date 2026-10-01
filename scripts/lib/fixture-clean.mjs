// Очистка записей живого прогона для фикстур (agents-smoke, image-smoke): пути временной и домашней
// папок, почта, вложения движка в транскрипте, MCP-инструменты и команды из init.
import { homedir } from 'node:os';

/**
 * @param {string} cwd временная папка прогона (realpath)
 * @param {string} encoded имя каталога транскриптов CLI для неё (`projectDirName(cwd)`)
 * @param {string} alias чем заменить путь папки (`/tmp/agentura-agents`)
 */
export function fixtureCleaner(cwd, encoded, alias) {
  const home = homedir();
  const encodedAlias = alias.replace(/\//g, '-');
  const clean = (text) =>
    text
      .split(cwd)
      .join(alias)
      .split(cwd.replace(/^\/private/, ''))
      .join(alias)
      .split(encoded)
      .join(encodedAlias)
      .split(home)
      .join('/home/user')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com');
  // транскрипт: вложения движка (окружение, организация, список скиллов, контекст сессии) — не нужны
  // разбору и личные; остальное как есть
  const cleanJsonl = (text) =>
    text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          const r = JSON.parse(l);
          return r.type === 'attachment' ? undefined : clean(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .join('\n') + '\n';
  const scrub = (m) => {
    if (m.type === 'system' && m.subtype === 'init') {
      // MCP-инструменты и команды выдают подключённые коннекторы пользователя — в фикстуру не кладём.
      const tools = (m.tools ?? []).filter((t) => !String(t).startsWith('mcp__'));
      return { ...m, tools, slash_commands: [], skills: [], plugins: [], mcp_servers: [] };
    }
    if (m.type === 'system' && m.subtype === 'commands_changed') return { ...m, commands: [] };
    return m;
  };
  return { clean, cleanJsonl, scrub };
}
