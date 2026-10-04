// Шрифты из Google Fonts, скачанные пользователем: каталог, загрузка woff2, хранилище в папке данных расширения.
// Без `vscode`: только `node:fs/promises` и инъецируемый `fetch` — тестируется на временной папке.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const CATALOG_URL = 'https://fonts.google.com/metadata/fonts';
/** Кэш каталога живёт неделю; при ошибке сети берётся и старый. */
export const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;
/** woff2 Google отдаёт только современному браузеру. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SUBSETS = new Set(['latin', 'latin-ext', 'cyrillic']);
const WANTED_WEIGHTS = [400, 500, 600, 700];
/** Файлы шрифтов — только с CDN Google; больше лимита — не шрифт, а что-то не то. */
const FONT_HOST = 'https://fonts.gstatic.com/';
const MAX_FONT_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_CHARS = 32 * 1024 * 1024;
// имя семейства и значения из ответа сети попадают в fonts.css и в путь на диске — пропускаем только ожидаемое
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const WEIGHT_RE = /^\d{1,4}(?: \d{1,4})?$/;
const RANGE_RE = /^[Uu]\+[0-9A-Fa-f?]+(?:-[0-9A-Fa-f]+)?(?:,\s*[Uu]\+[0-9A-Fa-f?]+(?:-[0-9A-Fa-f]+)?)*$/;

export interface CatalogFamily {
  family: string;
  category: string;
  subsets: string[];
  /** Нормальные (не курсивные) начертания, по возрастанию. */
  weights: number[];
  popularity: number;
}

export type FontKind = 'ui' | 'code';

export interface UserFont {
  family: string;
  kind: FontKind;
  /** Файлы woff2 относительно папки шрифтов (`<slug>/latin-0.woff2`). */
  files: string[];
}

export interface FontFace {
  subset: string;
  weight: string;
  range: string;
  url: string;
}

/** Минимум от ответа `fetch`. */
export interface ResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<ResponseLike>;
/** Повисший запрос не должен держать уведомление и очередь правок вечно. */
const FETCH_TIMEOUT_MS = 60_000;

/** Имя папки семейства: только `[a-z0-9-]` — без `/`, `\\`, `..`; пустой slug — ошибка (иначе `rm` снёс бы всю папку). */
export function slugOf(family: string): string {
  const slug = family.toLowerCase().replace(/[^a-z0-9-]+/g, '');
  if (!slug || !FAMILY_RE.test(family)) throw new Error(`unsupported font family name: ${JSON.stringify(family)}`);
  return slug;
}
export const kindOf = (category: string): FontKind => (category === 'Monospace' ? 'code' : 'ui');

/** Тело `fonts.google.com/metadata/fonts` (может начинаться с `)]}'`) → семейства по популярности. */
export function parseCatalog(text: string): CatalogFamily[] {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('catalog: not JSON');
  const data = JSON.parse(text.slice(start)) as { familyMetadataList?: unknown };
  if (!Array.isArray(data.familyMetadataList)) throw new Error('catalog: no familyMetadataList');
  const out: CatalogFamily[] = [];
  for (const raw of data.familyMetadataList as Record<string, unknown>[]) {
    if (typeof raw?.family !== 'string' || !FAMILY_RE.test(raw.family)) continue;
    const fonts = typeof raw.fonts === 'object' && raw.fonts !== null ? Object.keys(raw.fonts) : [];
    out.push({
      family: raw.family,
      category: typeof raw.category === 'string' ? raw.category : '',
      subsets: Array.isArray(raw.subsets) ? raw.subsets.filter((s): s is string => typeof s === 'string') : [],
      weights: fonts
        .filter((k) => /^\d+$/.test(k))
        .map(Number)
        .sort((a, b) => a - b),
      popularity: typeof raw.popularity === 'number' ? raw.popularity : Number.MAX_SAFE_INTEGER,
    });
  }
  return out.sort((a, b) => a.popularity - b.popularity);
}

/** Веса для загрузки: пересечение {400,500,600,700} с имеющимися; пусто — один ближайший к 400. */
export function pickWeights(available: readonly number[]): number[] {
  const hit = WANTED_WEIGHTS.filter((w) => available.includes(w));
  if (hit.length > 0 || available.length === 0) return hit;
  return [[...available].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400) || a - b)[0]!];
}

// Ответ css2: блоки «комментарий-набор + @font-face»; берём только нужные наборы, дубли отбрасываем.
export function parseFontCss(css: string): FontFace[] {
  const out: FontFace[] = [];
  const seen = new Set<string>();
  for (const [, subset, body] of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*{([^}]*)}/g)) {
    if (!subset || !body || !SUBSETS.has(subset)) continue;
    const url = body.match(/url\(([^)]+)\)/)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    const weight = body.match(/font-weight:\s*([^;]+);/)?.[1]?.trim();
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
    if (!url || !weight || !range) continue;
    if (!url.startsWith(FONT_HOST) || !WEIGHT_RE.test(weight) || !RANGE_RE.test(range)) continue;
    const key = `${url}|${weight}|${range}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subset, weight, range, url });
  }
  return out;
}

/** `@font-face` для одного файла; `file` — путь относительно fonts.css. */
export function fontFaceCss(family: string, weight: string, file: string, range: string): string {
  const name = family.replace(/[^A-Za-z0-9 ._-]/g, '');
  return (
    `@font-face { font-family: "${name}"; font-style: normal; font-weight: ${weight}; font-display: swap; ` +
    `src: url("${file}") format("woff2"); unicode-range: ${range}; }`
  );
}

export interface UserFontsDeps {
  /** Папка шрифтов (`<globalStorage>/fonts`). */
  dir: string;
  fetch: FetchLike;
  now?: () => number;
  warn?: (message: string) => void;
}

/** Скачанные шрифты: каталог, add / remove / list, `onDidChange`. Правки идут по очереди. */
export class UserFonts {
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: UserFontsDeps) {}

  get dir(): string {
    return this.deps.dir;
  }

  get cssPath(): string {
    return join(this.deps.dir, 'fonts.css');
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  async list(): Promise<UserFont[]> {
    try {
      const data: unknown = JSON.parse(await readFile(join(this.deps.dir, 'fonts.json'), 'utf8'));
      if (!Array.isArray(data)) return [];
      return data.filter(
        (f): f is UserFont =>
          typeof f?.family === 'string' &&
          FAMILY_RE.test(f.family) &&
          (f.kind === 'ui' || f.kind === 'code') &&
          Array.isArray(f.files),
      );
    } catch {
      return [];
    }
  }

  /** Каталог: свежий кэш → сеть → старый кэш → ошибка. */
  async catalog(): Promise<CatalogFamily[]> {
    const file = join(this.deps.dir, 'catalog.json');
    const now = (this.deps.now ?? Date.now)();
    let cached: { fetchedAt: number; families: CatalogFamily[] } | undefined;
    try {
      const c = JSON.parse(await readFile(file, 'utf8')) as { fetchedAt?: unknown; families?: unknown };
      // кэш мог записать старый билд или испортить что угодно — проверяем форму каждой записи
      if (typeof c.fetchedAt === 'number' && Array.isArray(c.families))
        cached = { fetchedAt: c.fetchedAt, families: c.families.filter(isCatalogFamily) };
    } catch {
      /* нет кэша */
    }
    const age = cached ? now - cached.fetchedAt : -1;
    if (cached && cached.families.length > 0 && age >= 0 && age < CATALOG_TTL_MS) return cached.families;
    try {
      const r = await this.get(CATALOG_URL);
      const text = await r.text();
      if (text.length > MAX_CATALOG_CHARS) throw new Error('catalog: response too large');
      const families = parseCatalog(text);
      await mkdir(this.deps.dir, { recursive: true });
      await writeAtomic(file, JSON.stringify({ fetchedAt: now, families }));
      return families;
    } catch (e) {
      if (cached && cached.families.length > 0) {
        this.deps.warn?.(`catalog: сеть недоступна, беру старый кэш (${String(e)})`);
        return cached.families;
      }
      throw new Error(`Google Fonts catalog unavailable: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }

  add(info: Pick<CatalogFamily, 'family' | 'category' | 'weights'>): Promise<UserFont> {
    return this.serial(async () => {
      const { family } = info;
      const slug = slugOf(family);
      const weights = pickWeights(info.weights);
      if (weights.length === 0) throw new Error(`${family}: no normal weights`);
      const query = encodeURIComponent(family).replace(/%20/g, '+');
      const sheet = await this.get(
        `https://fonts.googleapis.com/css2?family=${query}:wght@${weights.join(';')}&display=swap`,
      );
      const faces = parseFontCss(await sheet.text());
      if (faces.length === 0) throw new Error(`${family}: no font files in the response`);
      // качаем во временную папку и только потом подменяем: оборванная загрузка не портит установленное;
      // имя уникально — другое окно VS Code (globalStorage общий) может качать то же семейство
      const tmp = join(this.deps.dir, `.${slug}.${randomBytes(4).toString('hex')}.tmp`);
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      try {
        const names = new Map<string, string>();
        const css: string[] = [];
        for (const f of faces) {
          if (!names.has(f.url)) {
            const name = `${f.subset}-${names.size}.woff2`;
            const data = Buffer.from(await (await this.get(f.url)).arrayBuffer());
            if (data.length > MAX_FONT_BYTES || data.subarray(0, 4).toString('latin1') !== 'wOF2')
              throw new Error(`${family}: not a woff2 file (${f.url})`);
            await writeFile(join(tmp, name), data);
            names.set(f.url, name);
          }
          css.push(fontFaceCss(family, f.weight, `${slug}/${names.get(f.url)!}`, f.range));
        }
        await writeFile(join(tmp, 'face.css'), css.join('\n') + '\n');
        await rm(join(this.deps.dir, slug), { recursive: true, force: true });
        await rename(tmp, join(this.deps.dir, slug));
        const font: UserFont = {
          family,
          kind: kindOf(info.category),
          files: [...names.values()].map((n) => `${slug}/${n}`),
        };
        const rest = (await this.list()).filter((f) => f.family !== family);
        await this.save([...rest, font]);
        return font;
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }).then((font) => {
      this.fire();
      return font;
    });
  }

  remove(family: string): Promise<boolean> {
    return this.serial(async () => {
      const all = await this.list();
      const rest = all.filter((f) => f.family !== family);
      if (rest.length === all.length) return false;
      // удаляем только семейство из манифеста; сначала манифест и css — тогда упавший rm оставит лишь лишнюю папку
      await this.save(rest);
      await rm(join(this.deps.dir, slugOf(family)), { recursive: true, force: true });
      return true;
    }).then((removed) => {
      if (removed) this.fire();
      return removed;
    });
  }

  private async get(url: string): Promise<ResponseLike> {
    const r = await this.deps.fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r;
  }

  /** Манифест и fonts.css (склейка `face.css` оставшихся семейств). */
  private async save(fonts: UserFont[]): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true });
    const parts: string[] = [];
    for (const f of fonts) {
      try {
        parts.push((await readFile(join(this.deps.dir, slugOf(f.family), 'face.css'), 'utf8')).trimEnd());
      } catch {
        /* семейство без стилей или с негодным именем — пропускаем */
      }
    }
    await writeAtomic(
      this.cssPath,
      '/* Сгенерировано расширением из скачанных шрифтов — не править руками. */\n' + parts.join('\n') + '\n',
    );
    await writeAtomic(join(this.deps.dir, 'fonts.json'), JSON.stringify(fonts, null, 2));
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private fire(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** Запись через временный файл и rename: читатель (и другое окно VS Code) не увидит полузаписанный файл. */
async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

function isCatalogFamily(f: unknown): f is CatalogFamily {
  const x = f as Partial<CatalogFamily> | null;
  return (
    typeof x?.family === 'string' &&
    FAMILY_RE.test(x.family) &&
    typeof x.category === 'string' &&
    Array.isArray(x.subsets) &&
    x.subsets.every((s) => typeof s === 'string') &&
    Array.isArray(x.weights) &&
    x.weights.every((w) => typeof w === 'number') &&
    typeof x.popularity === 'number'
  );
}
