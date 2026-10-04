import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_TTL_MS,
  UserFonts,
  fontFaceCss,
  kindOf,
  parseCatalog,
  parseFontCss,
  pickWeights,
  slugOf,
  type FetchLike,
} from './googleFonts';

const CATALOG = `)]}'\n${JSON.stringify({
  familyMetadataList: [
    { family: 'Rare', category: 'Display', subsets: ['latin'], fonts: { '400': {} }, popularity: 900 },
    {
      family: 'Onest',
      category: 'Sans Serif',
      subsets: ['cyrillic', 'latin'],
      fonts: { '400': {}, '400i': {}, '700': {} },
      popularity: 5,
    },
    { family: 'Bad' },
    { family: 'Fira Code', category: 'Monospace', subsets: ['latin'], fonts: { '500': {} }, popularity: 7 },
  ],
})}`;

const CSS = `/* cyrillic */
@font-face {
  font-family: 'Onest';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/onest/cyr.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F;
}
/* vietnamese */
@font-face {
  font-family: 'Onest';
  font-weight: 400 700;
  src: url(https://fonts.gstatic.com/s/onest/vi.woff2) format('woff2');
  unicode-range: U+0102-0103;
}
/* latin */
@font-face {
  font-family: 'Onest';
  font-weight: 400 700;
  src: url(https://fonts.gstatic.com/s/onest/lat.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
/* latin */
@font-face {
  font-family: 'Onest';
  font-weight: 400 700;
  src: url(https://fonts.gstatic.com/s/onest/lat.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;

describe('parseCatalog', () => {
  it('отрезает префикс )]}\', сортирует по популярности, пропускает мусор', () => {
    const list = parseCatalog(CATALOG);
    expect(list.map((f) => f.family)).toEqual(['Onest', 'Fira Code', 'Rare', 'Bad']);
    expect(list[0]).toMatchObject({ category: 'Sans Serif', weights: [400, 700] });
    expect(list[0]!.subsets).toContain('cyrillic');
  });
  it('без префикса тоже работает; не JSON — ошибка', () => {
    expect(parseCatalog(CATALOG.slice(5))).toHaveLength(4);
    expect(() => parseCatalog('<html>')).toThrow();
  });
});

describe('pickWeights', () => {
  it('пересечение с 400–700', () => {
    expect(pickWeights([100, 400, 500, 900])).toEqual([400, 500]);
  });
  it('нет пересечения — ближайший к 400', () => {
    expect(pickWeights([100, 300, 900])).toEqual([300]);
    expect(pickWeights([900])).toEqual([900]);
  });
  it('пусто — пусто', () => {
    expect(pickWeights([])).toEqual([]);
  });
});

describe('parseFontCss / fontFaceCss', () => {
  it('берёт latin / latin-ext / cyrillic, дубли отбрасывает', () => {
    const faces = parseFontCss(CSS);
    expect(faces.map((f) => f.subset)).toEqual(['cyrillic', 'latin']);
    expect(faces[0]).toEqual({
      subset: 'cyrillic',
      weight: '400 700',
      range: 'U+0301, U+0400-045F',
      url: 'https://fonts.gstatic.com/s/onest/cyr.woff2',
    });
  });
  it('fontFaceCss: относительный url и кавычки в имени не ломают правило', () => {
    const css = fontFaceCss('A"B', '400', 'a/latin-0.woff2', 'U+0000');
    expect(css).toContain('font-family: "AB"');
    expect(css).toContain('url("a/latin-0.woff2")');
  });
  it('чужой url, негодные вес и unicode-range из ответа отбрасываются', () => {
    const bad = `/* latin */
@font-face { font-weight: 400; src: url(https://evil.example/x.woff2); unicode-range: U+0000-00FF; }
/* latin */
@font-face { font-weight: 400{}; src: url(https://fonts.gstatic.com/a.woff2); unicode-range: U+0000; }
/* latin */
@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/b.woff2); unicode-range: U+0000</style>; }
/* latin */
@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/ok.woff2); unicode-range: U+0000-00FF, U+0131; }`;
    expect(parseFontCss(bad).map((f) => f.url)).toEqual(['https://fonts.gstatic.com/ok.woff2']);
  });
  it('slug: только [a-z0-9-]; путь и пустое имя — ошибка', () => {
    expect(() => slugOf('../evil')).toThrow('unsupported');
    expect(() => slugOf('a/b')).toThrow('unsupported');
    expect(() => slugOf('a\\b')).toThrow('unsupported');
    expect(() => slugOf('')).toThrow('unsupported');
    expect(() => slugOf('   ')).toThrow('unsupported');
  });
  it('slug и kind', () => {
    expect(slugOf('Fira Code')).toBe('firacode');
    expect(kindOf('Monospace')).toBe('code');
    expect(kindOf('Serif')).toBe('ui');
  });
});

function fakeFetch(opts: { catalog?: () => string; fail?: boolean; font?: string } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    if (opts.fail) throw new Error('offline');
    const body = url.startsWith('https://fonts.google.com/metadata')
      ? (opts.catalog?.() ?? CATALOG)
      : url.startsWith('https://fonts.googleapis.com/css2')
        ? CSS
        : (opts.font ?? 'wOF2-font-data');
    return {
      ok: true,
      status: 200,
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
  return Object.assign(fn, { calls });
}

describe('UserFonts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentura-fonts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('add: файлы, манифест, fonts.css, событие; url качается один раз', async () => {
    const f = fakeFetch();
    const fonts = new UserFonts({ dir, fetch: f });
    const changed = vi.fn();
    fonts.onDidChange(changed);
    const added = await fonts.add({ family: 'Onest', category: 'Sans Serif', weights: [400, 700] });
    expect(added).toEqual({
      family: 'Onest',
      kind: 'ui',
      files: ['onest/cyrillic-0.woff2', 'onest/latin-1.woff2'],
    });
    expect(f.calls[0]).toBe('https://fonts.googleapis.com/css2?family=Onest:wght@400;700&display=swap');
    expect(f.calls.filter((u) => u.endsWith('lat.woff2'))).toHaveLength(1);
    expect(await readdir(join(dir, 'onest'))).toContain('latin-1.woff2');
    expect(await fonts.list()).toEqual([added]);
    const css = await readFile(fonts.cssPath, 'utf8');
    expect(css).toContain('font-family: "Onest"');
    expect(css).toContain('url("onest/cyrillic-0.woff2")');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('add: имя с пробелом кодируется плюсом; моноширинный — kind code', async () => {
    const f = fakeFetch();
    const fonts = new UserFonts({ dir, fetch: f });
    const added = await fonts.add({ family: 'Fira Code', category: 'Monospace', weights: [500] });
    expect(added.kind).toBe('code');
    expect(f.calls[0]).toContain('family=Fira+Code:wght@500');
  });

  it('add повторно заменяет, а не дублирует', async () => {
    const fonts = new UserFonts({ dir, fetch: fakeFetch() });
    const info = { family: 'Onest', category: 'Sans Serif', weights: [400] };
    await fonts.add(info);
    await fonts.add(info);
    expect(await fonts.list()).toHaveLength(1);
    expect((await readFile(fonts.cssPath, 'utf8')).match(/@font-face/g)).toHaveLength(2);
  });

  it('ошибка загрузки: ничего не остаётся, события нет', async () => {
    const fonts = new UserFonts({ dir, fetch: fakeFetch({ fail: true }) });
    const changed = vi.fn();
    fonts.onDidChange(changed);
    await expect(fonts.add({ family: 'Onest', category: 'Serif', weights: [400] })).rejects.toThrow('offline');
    expect(await fonts.list()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('не woff2 в ответе — ошибка, ничего не остаётся', async () => {
    const fonts = new UserFonts({ dir, fetch: fakeFetch({ font: '<html>' }) });
    await expect(fonts.add({ family: 'Onest', category: 'Serif', weights: [400] })).rejects.toThrow('woff2');
    expect(await fonts.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('имя-путь: add отказывает до сети, remove не по манифесту — ничего не удаляет', async () => {
    const f = fakeFetch();
    const fonts = new UserFonts({ dir, fetch: f });
    await fonts.add({ family: 'Onest', category: 'Sans Serif', weights: [400] });
    await expect(fonts.add({ family: '../onest', category: 'Serif', weights: [400] })).rejects.toThrow('unsupported');
    expect(f.calls.some((u) => u.includes('..'))).toBe(false);
    expect(await fonts.remove('../onest')).toBe(false);
    expect(await fonts.remove('')).toBe(false);
    expect(await readdir(dir)).toContain('onest');
  });

  it('add + remove подряд без ожидания идут по очереди', async () => {
    const fonts = new UserFonts({ dir, fetch: fakeFetch() });
    const a = fonts.add({ family: 'Onest', category: 'Sans Serif', weights: [400] });
    const b = fonts.add({ family: 'Fira Code', category: 'Monospace', weights: [500] });
    const c = fonts.remove('Onest');
    await Promise.all([a, b, c]);
    expect((await fonts.list()).map((f) => f.family)).toEqual(['Fira Code']);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('remove: папка, манифест и css; чужое семейство не трогает', async () => {
    const fonts = new UserFonts({ dir, fetch: fakeFetch() });
    await fonts.add({ family: 'Onest', category: 'Sans Serif', weights: [400] });
    await fonts.add({ family: 'Fira Code', category: 'Monospace', weights: [500] });
    const changed = vi.fn();
    fonts.onDidChange(changed);
    expect(await fonts.remove('Onest')).toBe(true);
    expect((await fonts.list()).map((f) => f.family)).toEqual(['Fira Code']);
    expect(await readdir(dir)).not.toContain('onest');
    const css = await readFile(fonts.cssPath, 'utf8');
    expect(css).not.toContain('"Onest"');
    expect(css).toContain('"Fira Code"');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await fonts.remove('Nope')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('каталог: кэш из будущего или чужой формы не считается свежим', async () => {
    const f = fakeFetch();
    const fonts = new UserFonts({ dir, fetch: f, now: () => 1000 });
    await writeFile(join(dir, 'catalog.json'), JSON.stringify({ fetchedAt: 99_999, families: [{ family: 'X' }] }));
    expect((await fonts.catalog())[0]!.family).toBe('Onest');
    expect(f.calls).toHaveLength(1);
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({ fetchedAt: 99_999, families: [{ family: 'Onest', category: 'Serif', subsets: [], weights: [400], popularity: 1 }] }),
    );
    await fonts.catalog();
    expect(f.calls).toHaveLength(2);
  });

  it('каталог: кэш 7 дней, потом сеть; при сбое — старый кэш; без кэша — ошибка', async () => {
    let t = 1_000_000;
    const f = fakeFetch();
    const fonts = new UserFonts({ dir, fetch: f, now: () => t, warn: () => {} });
    expect((await fonts.catalog())[0]!.family).toBe('Onest');
    await fonts.catalog();
    expect(f.calls).toHaveLength(1);
    t += CATALOG_TTL_MS + 1;
    await fonts.catalog();
    expect(f.calls).toHaveLength(2);
    t += CATALOG_TTL_MS + 1;
    const offline = new UserFonts({ dir, fetch: fakeFetch({ fail: true }), now: () => t, warn: () => {} });
    expect((await offline.catalog())[0]!.family).toBe('Onest');
    await writeFile(join(dir, 'catalog.json'), 'мусор');
    await expect(offline.catalog()).rejects.toThrow('unavailable');
  });
});
