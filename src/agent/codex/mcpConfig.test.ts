import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { mcpEnabledConfig, setProjectMcpEnabled } from './mcpConfig';

const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'agentura-mcp-config-')); dirs.push(dir); return dir; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const value = (text: string) => getStaticTOMLValue(parseTOML(text));

describe('project Codex MCP config', () => {
  it('меняет только boolean, сохраняя комментарии и строки с похожими заголовками', () => {
    const original = '# keep\n[mcp_servers."a.b"]\nenabled = true # keep too\ncommand = "node"\nargs = ["enabled = true"]\n';
    const result = mcpEnabledConfig(original, 'a.b', false);
    expect(result).toBe(original.replace('enabled = true #', 'enabled = false #'));
    expect(mcpEnabledConfig(result, 'a.b', false)).toBe(result);
  });

  it.each([
    '[mcp_servers.probe]\ncommand = "node"\n',
    '[mcp_servers]\nprobe.command = "node"\n',
    'mcp_servers.probe.command = "node"\n',
    'mcp_servers = { probe = { command = "node" } }\n',
    '[mcp_servers]\nprobe = { command = "node" }\n',
    '[mcp_servers.probe.env]\nFOO = "bar"\n',
    'description = """\n[mcp_servers.probe]\nenabled = true\n"""\n[mcp_servers.probe]\ncommand = "node"\n',
  ])('вставляет ключ в разные допустимые формы TOML: %s', (original) => {
    const result = mcpEnabledConfig(original, 'probe', false);
    expect(value(result)).toMatchObject({ mcp_servers: { probe: { enabled: false } } });
    expect(value(result)).toMatchObject(value(original));
    expect(value(mcpEnabledConfig(result, 'probe', true))).toMatchObject({ mcp_servers: { probe: { enabled: true } } });
  });

  it('создаёт только локальный override и сохраняет CRLF', () => {
    const result = mcpEnabledConfig('model = "x"\r\n', 'a"b', false);
    expect(value(result)).toEqual({ model: 'x', mcp_servers: { 'a"b': { enabled: false } } });
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('некорректный TOML не перезаписывается', async () => {
    const dir = await temp();
    await mkdir(join(dir, '.codex'));
    const file = join(dir, '.codex/config.toml');
    await writeFile(file, '[broken');
    await expect(setProjectMcpEnabled(dir, 'probe', false)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('[broken');
  });

  it('одновременные переключения разных чатов не затирают друг друга', async () => {
    const dir = await temp();
    await Promise.all([setProjectMcpEnabled(dir, 'a', false), setProjectMcpEnabled(dir, 'b', true)]);
    expect(value(await readFile(join(dir, '.codex/config.toml'), 'utf8'))).toEqual({ mcp_servers: {
      a: { enabled: false }, b: { enabled: true },
    } });
  });

  it('ссылка на общий конфиг не изменяет его', async () => {
    const dir = await temp();
    const global = join(dir, 'global.toml');
    await writeFile(global, 'model = "keep"\n');
    await mkdir(join(dir, '.codex'));
    await symlink(global, join(dir, '.codex/config.toml'));
    await expect(setProjectMcpEnabled(dir, 'probe', false)).rejects.toThrow(/regular file/);
    expect(await readFile(global, 'utf8')).toBe('model = "keep"\n');
  });
});
