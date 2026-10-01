/**
 * Файлы-вложения на стороне хоста (этап 8 roadmap 0.2), без `vscode`: разбор файла из «+» и
 * перетаскивания (картинка → путь этапа 4, текст и pdf → `PickedFile`), путь для модели, временная
 * копия для просмотра файла вне рабочей папки (`globalStorageUri/attachments`, 50 последних).
 */
import { createHash } from 'node:crypto';
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { FileKind } from '../agent/types';
import type { PickedFile, PickedImage } from '../protocol';
import { imageTypeOfName } from '../shared/images';
import {
  classifyBytes,
  fileName,
  FOREIGN_IMAGE_EXT,
  MAX_ATTACH_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  MAX_PDF_PAGES,
  pagesOf,
  pdfPageStats,
  type FileProblem,
} from '../shared/files';
import { MAX_IMAGES_PER_MESSAGE } from '../shared/images';
import { pruneImages } from './imageFiles';

/** Сколько временных копий файлов хранить. */
export const KEEP_ATTACHMENTS = 50;
/**
 * Сколько байт файлов читать за один «+» или одно перетаскивание (всё уходит webview одним сообщением):
 * картинки уменьшает webview, поэтому сырой объём больше лимита сообщения 20 МБ, но не сотни МБ.
 */
export const MAX_PICK_BYTES = 128 * 1024 * 1024;
/** Сколько uri брать из одного перетаскивания (картинки и файлы вместе). */
export const MAX_DROPPED = MAX_IMAGES_PER_MESSAGE + MAX_FILES_PER_MESSAGE;

export interface Picked {
  images: PickedImage[];
  files: PickedFile[];
}

/** Что известно о файле до чтения. */
export interface AttachSource {
  /** Путь на диске (`Uri.fsPath`) — из него путь для модели. */
  fsPath: string;
  /** Размер; `undefined` — `stat` не прочитался. */
  size?: number;
  isDir?: boolean;
  read(): Promise<Uint8Array>;
}

/**
 * Путь для модели: файл внутри рабочей папки — относительно неё, с `/`; вне её — абсолютный.
 */
export function modelPath(cwd: string, fsPath: string): string {
  const rel = relative(cwd, fsPath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  return fsPath;
}

/**
 * Относительный путь чипа → файл в рабочей папке; выход за неё (`..`) и абсолютный путь —
 * `undefined` (такие открываются копией).
 */
export function workspaceTarget(cwd: string, path: string): string | undefined {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return undefined;
  const abs = resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return abs;
}

/** Похоже на картинку по имени — отказ показываем плашкой картинки (этап 4: «HEIC не берём»). */
function imageByName(name: string): boolean {
  return imageTypeOfName(name) !== undefined || FOREIGN_IMAGE_EXT.test(name);
}

export function rejected(name: string, problem: FileProblem): Picked {
  if (imageByName(name) && problem !== 'folder' && problem !== 'outside') {
    const imageProblem =
      problem === 'size' || problem === 'read' || problem === 'total' || problem === 'count'
        ? problem
        : 'format';
    const mediaType = imageTypeOfName(name);
    return {
      images: [{ name, ...(mediaType ? { mediaType } : {}), problem: imageProblem }],
      files: [],
    };
  }
  return { images: [], files: [{ name, problem }] };
}

/**
 * Один файл → картинка (`image.picked`, уменьшает webview) или текст/pdf (`file.picked`). Тип — по
 * содержимому; размер проверяется до чтения, папка и непрочитанный `stat` не читаются вовсе.
 */
export async function readAttachment(cwd: string, src: AttachSource): Promise<Picked> {
  const name = fileName(src.fsPath) || 'file';
  if (src.isDir) return rejected(name, 'folder');
  if (src.size === undefined) return rejected(name, 'read');
  if (src.size > MAX_ATTACH_FILE_BYTES) return rejected(name, 'size');
  let bytes: Uint8Array;
  try {
    bytes = await src.read();
  } catch {
    return rejected(name, 'read');
  }
  const c = classifyBytes(bytes);
  if ('problem' in c) return rejected(name, c.problem);
  if (c.kind === 'image') {
    return {
      images: [{ name, mediaType: c.mediaType, data: Buffer.from(bytes).toString('base64') }],
      files: [],
    };
  }
  // HEIC/svg, оказавшийся «текстом» (svg — это xml), и битый .png — всё равно картинка не нашего формата
  if (imageByName(name)) return rejected(name, 'binary');
  const path = modelPath(cwd, src.fsPath);
  if (c.kind === 'pdf') {
    // страницы ещё раз — с распаковкой сжатых потоков объектов: не посчитали — API, скорее всего,
    // тоже не прочтёт, а его отказ остался бы в транскрипте (каждый следующий ход — 400)
    const pages = pdfPagesDeep(bytes);
    if (pages === undefined) return rejected(name, 'pdf');
    if (pages > MAX_PDF_PAGES) return rejected(name, 'pages');
    return {
      images: [],
      files: [
        {
          name,
          path,
          kind: 'pdf',
          data: Buffer.from(bytes).toString('base64'),
          size: bytes.length,
          pages,
        },
      ],
    };
  }
  return {
    images: [],
    files: [{ name, path, kind: 'text', data: c.text, size: bytes.length }],
  };
}

/** Сколько распакованных байт потоков объектов pdf разбирать на файл, не больше. */
const MAX_PDF_INFLATE_BYTES = 64 * 1024 * 1024;

/**
 * Страниц в pdf с учётом сжатых потоков объектов (pdf 1.5+, `/Type /ObjStm` + FlateDecode): там
 * лежат и `/Type /Pages /Count`, и сами страницы, и `pdfPages` по сырому файлу их не видит.
 * `/Count` — наибольший, объекты `/Type /Page` (запасной путь) — сумма по файлу и потокам.
 * `undefined` — не нашли.
 */
export function pdfPagesDeep(bytes: Uint8Array): number | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bin = buf.toString('latin1');
  const stats = pdfPageStats(bin);
  let count = stats.count;
  let objects = stats.objects;
  let budget = MAX_PDF_INFLATE_BYTES;
  for (const m of bin.matchAll(/\/Type\s*\/ObjStm\b/g)) {
    const kw = bin.indexOf('stream', m.index);
    const endobj = bin.indexOf('endobj', m.index);
    if (kw < 0 || (endobj >= 0 && endobj < kw) || budget <= 0) continue;
    let start = kw + 'stream'.length;
    if (bin[start] === '\r') start++;
    if (bin[start] === '\n') start++;
    const end = bin.indexOf('endstream', start);
    if (end < 0) continue;
    let text: string;
    try {
      const out = inflateSync(buf.subarray(start, end), { maxOutputLength: budget });
      budget -= out.length;
      text = out.toString('latin1');
    } catch {
      continue; // не Flate или битый поток — что видно в сыром файле, то и считаем
    }
    const s = pdfPageStats(text);
    count = Math.max(count, s.count);
    objects += s.objects;
  }
  return pagesOf({ count, objects });
}

/**
 * Перетащенный путь внутри одной из папок воркспейса (webview недоверенный — он присылает строку,
 * а не жест, поэтому хост читает только рабочие папки и открытые вкладки). `remote` — путь uri
 * (`/`-пути удалённого окна), иначе — путь диска.
 */
export function dropAllowed(path: string, roots: readonly string[], remote = false): boolean {
  const rel = remote ? posix.relative : relative;
  const abs = remote ? posix.isAbsolute : isAbsolute;
  return roots.some((root) => {
    const r = rel(root, path);
    return r !== '' && !r.startsWith('..') && !abs(r);
  });
}

/** Слить результаты по файлам. */
export function mergePicked(list: readonly Picked[]): Picked {
  return {
    images: list.flatMap((p) => p.images),
    files: list.flatMap((p) => p.files),
  };
}

/**
 * uri из перетаскивания (`text/uri-list`: строки, `#` — комментарий). Берём не больше `max`;
 * пустые и дубли выкидываем.
 */
export function parseUriList(raw: readonly unknown[], max = MAX_DROPPED): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    for (const line of item.split(/\r?\n/)) {
      const u = line.trim();
      if (!u || u.startsWith('#') || out.includes(u)) continue;
      out.push(u);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Имя временной копии: имя файла и хэш содержимого (повторный клик — тот же файл). */
export function attachmentFileName(f: { kind: FileKind; path: string; data: string }): string {
  const hash = createHash('sha256').update(f.data).digest('hex').slice(0, 12);
  const base = fileName(f.path).replace(/[^\w.\-а-яА-ЯёЁ ]/g, '_') || 'file';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = f.kind === 'pdf' ? 'pdf' : dot > 0 ? base.slice(dot + 1) : 'txt';
  return `${stem.slice(0, 80)}-${hash}.${ext}`;
}

/** Записать копию файла (текст — UTF-8, pdf — из base64) во временную папку; путь к ней. */
export async function writeAttachmentTemp(
  dir: string,
  f: { kind: FileKind; path: string; data: string },
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, attachmentFileName(f));
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await writeFile(path, f.kind === 'pdf' ? Buffer.from(f.data, 'base64') : f.data);
    await pruneImages(dir, KEEP_ATTACHMENTS).catch(() => undefined);
  } else {
    // открыт снова — свежий: уборка по mtime не выкинет копию, которая сейчас во вкладке
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
  }
  return path;
}
