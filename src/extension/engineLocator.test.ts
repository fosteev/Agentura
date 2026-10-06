import { describe, expect, it, vi } from 'vitest';
import type { ResolvedExecutable } from '../agent/claude/executable';
import { EngineLocator } from './engineLocator';

function make(results: ResolvedExecutable[], setting = { v: '' }) {
  const resolve = vi.fn(() => Promise.resolve(results.shift()!));
  const deps = { setting: () => setting.v, resolve, info: vi.fn(), warn: vi.fn(), notify: vi.fn() };
  return { loc: new EngineLocator(deps), deps, resolve, setting };
}
const found: ResolvedExecutable = { path: '/a/claude', version: '2.1.285', source: 'system' };
const none: ResolvedExecutable = { source: 'none', problem: 'Не найден Claude Code' };

describe('EngineLocator', () => {
  it('найденный путь кэшируется, параллельные запросы делят один поиск', async () => {
    const { loc, resolve } = make([found]);
    loc.warm();
    expect(await Promise.all([loc.path(), loc.path()])).toEqual(['/a/claude', '/a/claude']);
    expect(await loc.path()).toBe('/a/claude');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('«не найден» не кэшируется: после установки следующий запрос находит', async () => {
    const { loc, resolve } = make([none, found]);
    expect(await loc.ready()).toEqual({ ok: false, problem: 'Не найден Claude Code' });
    expect(await loc.ready()).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('смена настройки сбрасывает кэш', async () => {
    const { loc, resolve, setting } = make([found, { ...found, path: '/b/claude' }]);
    await loc.path();
    setting.v = '/b/claude';
    expect(await loc.path()).toBe('/b/claude');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('предупреждение: в журнал всегда, всплывашка — только если путь найден, один раз на значение', async () => {
    const old = { ...found, problem: 'старая версия' };
    const a = make([old, old]);
    await a.loc.locate();
    expect(a.deps.warn).toHaveBeenCalledTimes(1);
    expect(a.deps.notify).toHaveBeenCalledTimes(1);
    const b = make([none, none]);
    await b.loc.locate();
    await b.loc.locate();
    expect(b.deps.warn).toHaveBeenCalledTimes(1);
    expect(b.deps.notify).not.toHaveBeenCalled();
  });

  it('тихая проба (списки сайдбара): «не найден» не пишется в журнал и не съедает предупреждение запуска', async () => {
    const { loc, deps } = make([none, none, none]);
    expect(await loc.available()).toBe(false);
    expect(await loc.available()).toBe(false);
    expect(deps.info).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
    // запуск сессии без движка — предупреждение, как раньше
    expect((await loc.ready()).ok).toBe(false);
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('тихая проба, к которой присоединился запуск, — «не найден» в журнале', async () => {
    const { loc, deps, resolve } = make([none]);
    const [quiet, loud] = await Promise.all([loc.available(), loc.ready()]);
    expect(quiet).toBe(false);
    expect(loud.ok).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('тихая проба: найденный путь кэшируется и пишется в журнал, старая версия предупреждает', async () => {
    const { loc, deps, resolve } = make([{ ...found, problem: 'старая версия' }]);
    expect(await loc.available()).toBe(true);
    expect(await loc.ready()).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(deps.info).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('путь из настройки не запускается — движок не готов, без всплывашки и без кэша', async () => {
    const broken: ResolvedExecutable = {
      path: '/x/claude',
      source: 'setting',
      problem: 'agentura.claudeExecutable: «/x/claude» не запускается',
    };
    const { loc, resolve, deps } = make([broken, found], { v: '/x/claude' });
    expect(await loc.ready()).toEqual({ ok: false, problem: broken.problem });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(await loc.ready()).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('настройку сменили во время поиска: результат старого значения не кэшируется', async () => {
    const { loc, resolve, setting } = make([found, { ...found, path: '/b/claude' }]);
    const first = loc.locate();
    setting.v = '/b/claude';
    expect((await first).path).toBe('/a/claude');
    expect(await loc.path()).toBe('/b/claude');
    expect(await loc.path()).toBe('/b/claude');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('падение поиска не залипает: следующий запрос ищет заново', async () => {
    const resolve = vi
      .fn<(s: string) => Promise<ResolvedExecutable>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(found);
    const loc = new EngineLocator({ setting: () => '', resolve, info: vi.fn(), warn: vi.fn() });
    await expect(loc.path()).rejects.toThrow('boom');
    expect(await loc.path()).toBe('/a/claude');
  });

  it('Codex-локатор: своё имя в журнале и своя ошибка «не найден», без смешения с Claude', async () => {
    const info = vi.fn();
    const codexFound: ResolvedExecutable = { path: '/a/codex', version: '0.160.0', source: 'system' };
    const loc = new EngineLocator({
      setting: () => '',
      resolve: vi.fn(() => Promise.resolve(codexFound)),
      name: 'codex',
      info,
      warn: vi.fn(),
    });
    expect(await loc.path()).toBe('/a/codex');
    expect(info).toHaveBeenCalledWith('codex: /a/codex 0.160.0 (system)');
    const missing = new EngineLocator({
      setting: () => '',
      resolve: () => Promise.resolve({ source: 'none' } as ResolvedExecutable),
      name: 'codex',
      notFound: 'Codex CLI (codex) was not found.',
      info,
      warn: vi.fn(),
    });
    expect(await missing.ready()).toEqual({ ok: false, problem: 'Codex CLI (codex) was not found.' });
  });
});
