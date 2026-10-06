/**
 * Файлы-вложения (этап 8 roadmap 0.2): текстовый файл и pdf рядом с картинками этапа 4. Чистые
 * функции без `vscode` и `node:` — ими пользуются хост (разбор файла, проверка `send`), webview
 * (чип, оценка токенов) и история (чипы из `document`-блоков транскрипта).
 *
 * Движку файл уходит `document`-блоком с `title` = путь: текст — `source: {type: 'text'}`, pdf —
 * `source: {type: 'base64', media_type: 'application/pdf'}` (живая разведка `scripts/attach-smoke.mjs`).
 */
import type { FileKind, FileRef, ImageMediaType, PromptFile } from '../agent/types';
import {
  base64Bytes,
  MAX_IMAGE_FILE_BYTES,
  MAX_MESSAGE_IMAGES_BASE64,
  sniffImageType,
} from './images';

/** Текстовый файл — не больше 256 КБ (решение владельца в roadmap). */
export const MAX_TEXT_FILE_BYTES = 256 * 1024;
/**
 * pdf — не больше 15 МБ: base64 ≈ 20 МБ, это общий лимит сообщения (лимит запроса API — 32 МБ;
 * отказ API остался бы в транскрипте и ронял бы каждый следующий ход).
 */
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
/** Лимит API — 100 страниц pdf в запросе. */
export const MAX_PDF_PAGES = 100;
/** Файлов в одном сообщении (как картинок). */
export const MAX_FILES_PER_MESSAGE = 10;
/** Картинки (base64), pdf (base64) и тексты одного сообщения вместе — тот же лимит, что у картинок. */
export const MAX_MESSAGE_ATTACH_CHARS = MAX_MESSAGE_IMAGES_BASE64;
/** Файл с диска больше этого не читаем вообще (что бы в нём ни было). */
export const MAX_ATTACH_FILE_BYTES = MAX_IMAGE_FILE_BYTES;
/** Оценка токенов страницы pdf: документация API — 1 500–3 000 на страницу (текст и картинка). */
export const PDF_PAGE_TOKENS = 1500;
/**
 * Вложения всей сессии (второй проход приёмки этапа 8): лимиты API — на запрос, а CLI шлёт в каждом
 * запросе всю историю с её `image`/`document`-блоками до компакции (живой прогон этапа 6). Поэтому
 * 100 страниц pdf и тело запроса считаются на сессию. Тело — base64 картинок и pdf и текст файлов:
 * 24 МБ из 32 МБ запроса, остальное — текст разговора и результаты инструментов.
 */
export const MAX_SESSION_PDF_PAGES = MAX_PDF_PAGES;
export const MAX_SESSION_ATTACH_CHARS = 24 * 1024 * 1024;
/** Какую долю свободного окна контекста могут занять вложения одного сообщения (остальное — ответ и инструменты). */
export const ATTACH_WINDOW_SHARE = 0.7;
/** Окно, если движок его ещё не сообщил (до первого хода): консервативное. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Что уже лежит в истории сессии с последней компакции. */
export interface SessionAttach {
  pdfPages: number;
  chars: number;
}

/** Страниц pdf для счёта сессии: известные, иначе по размеру (≈ 50 КБ на страницу, не меньше одной). */
export function sessionPdfPages(f: Pick<PromptFile, 'kind' | 'size' | 'pages'>): number {
  if (f.kind !== 'pdf') return 0;
  return f.pages ?? Math.max(1, Math.ceil(f.size / 50_000));
}

/** Токены вложения для бюджета окна: pdf без известного числа страниц — по оценке страниц из размера. */
export function attachFileTokens(f: Pick<PromptFile, 'kind' | 'data' | 'size' | 'pages'>): number {
  return fileTokens(f) ?? sessionPdfPages(f) * PDF_PAGE_TOKENS;
}

/** Сколько токенов окна можно отдать вложениям сообщения: доля свободного места. */
export function attachTokenBudget(window: number | undefined, used: number | undefined): number {
  return Math.max(
    0,
    Math.floor(((window ?? DEFAULT_CONTEXT_WINDOW) - (used ?? 0)) * ATTACH_WINDOW_SHARE),
  );
}

/**
 * Лимит сессии для ещё одного вложения: `used` — уже в истории (и в этом сообщении до него).
 * pdf сверх 100 страниц — `sessionPages`, тело запроса сверх 24 МБ — `session`.
 */
export function sessionProblem(
  used: SessionAttach,
  add: { pages?: number; chars: number },
): 'sessionPages' | 'session' | undefined {
  if (add.pages && used.pdfPages + add.pages > MAX_SESSION_PDF_PAGES) return 'sessionPages';
  if (used.chars + add.chars > MAX_SESSION_ATTACH_CHARS) return 'session';
  return undefined;
}

/** Длина пути в `title`: больше — не путь, а мусор из webview. */
const MAX_PATH_CHARS = 1024;

/**
 * Почему файл не взят: `binary` — не UTF-8 или есть NUL, `size` — больше лимита, `empty` — пустой
 * (API не принимает пустой документ), `folder` — папка, `pages` — pdf больше 100 страниц, `read` —
 * не прочитался, `count`/`total` — сверх лимита сообщения (webview), `foreign` — перетащили не
 * картинку не из VS Code (webview сам файлы не читает, путь к ним ему не дают), `engine` — движок вкладки
 * (Codex) не принимает файлы, только картинки, `pdf` — pdf
 * зашифрован или в нём не найти страниц (API не примет, а отказ остался бы в сессии).
 */
export type FileProblem =
  | 'binary'
  | 'size'
  | 'empty'
  | 'folder'
  | 'pages'
  | 'read'
  | 'count'
  | 'total'
  | 'foreign'
  | 'engine'
  | 'pdf'
  | 'sessionPages'
  | 'session'
  | 'context';

/** Что лежит в файле: картинка (дальше — путь этапа 4), pdf, текст или причина отказа. */
export type Classified =
  | { kind: 'image'; mediaType: ImageMediaType }
  | { kind: 'pdf'; pages?: number }
  | { kind: 'text'; text: string }
  | { problem: FileProblem };

/** Расширения картинок, которые API не берёт: их «+» и перетаскивание показывают плашкой этапа 4. */
export const FOREIGN_IMAGE_EXT = /\.(heic|heif|svg|bmp|tiff?|avif|ico|psd)$/i;

const PDF_MAGIC = '%PDF-';

function latin1(bytes: Uint8Array, from = 0, to = bytes.length): string {
  let out = '';
  const step = 0x8000;
  for (let i = from; i < to; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(to, i + step)));
  }
  return out;
}

/**
 * Страниц в pdf (`undefined` — не посчитать): наибольший `/Count` дерева страниц (или `/N` словаря
 * линеаризации); нет его — число объектов `/Type /Page`. Объекты — только запасной путь: при
 * инкрементальных сохранениях старые версии страниц остаются в файле и завышали бы число. В pdf
 * 1.5+ дерево бывает в сжатых потоках — хост распаковывает их (`pdfPagesDeep`).
 */
export function pdfPages(bin: string): number | undefined {
  return pagesOf(pdfPageStats(bin));
}

/** Страницы из сырья `pdfPageStats`: `/Count`, а без него — число объектов страниц. */
export function pagesOf(s: { count: number; objects: number }): number | undefined {
  const pages = s.count > 0 ? s.count : s.objects;
  return pages > 0 ? pages : undefined;
}

/**
 * Сырьё для подсчёта страниц: наибольший `/Count` дерева страниц и число объектов `/Type /Page` в
 * куске pdf (файл целиком или распакованный поток объектов — хост суммирует `objects` по кускам).
 */
export function pdfPageStats(bin: string): { count: number; objects: number } {
  let count = 0;
  for (const m of bin.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) {
    count = Math.max(count, Number(m[1]));
  }
  for (const m of bin.matchAll(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    count = Math.max(count, Number(m[1]));
  }
  for (const m of bin.matchAll(/\/Linearized\s+[\d.]+[^>]*?\/N\s+(\d+)/g)) {
    count = Math.max(count, Number(m[1]));
  }
  const objects = bin.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return { count, objects };
}

/**
 * Зашифрованный pdf (ключ `/Encrypt` в трейлере или словаре xref-потока — они не сжаты). API такой
 * не примет, а отказ остался бы в транскрипте и ронял бы каждый следующий ход сессии.
 */
export function pdfEncrypted(bin: string): boolean {
  return /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(bin);
}

/** Есть ли признаки двоичного: NUL-байт или невалидный UTF-8 (в `bytes` — начало файла). */
function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return false;
  } catch {
    return true;
  }
}

/**
 * Разбор содержимого файла (хост: «+», перетаскивание). Тип — по сигнатуре, не по имени: картинка
 * с чужим расширением уходит путём этапа 4, `.pdf` без `%PDF-` — как обычный файл.
 */
export function classifyBytes(bytes: Uint8Array): Classified {
  if (bytes.length === 0) return { problem: 'empty' };
  const image = sniffImageType(btoa(latin1(bytes, 0, Math.min(bytes.length, 16))));
  if (image) return { kind: 'image', mediaType: image };
  if (latin1(bytes, 0, Math.min(bytes.length, 5)) === PDF_MAGIC) {
    if (bytes.length > MAX_PDF_BYTES) return { problem: 'size' };
    const bin = latin1(bytes);
    // зашифрованный или обрезанный (нет `%%EOF` в конце) — API не примет, отказ остался бы в сессии
    if (pdfEncrypted(bin) || !bin.slice(-2048).includes('%%EOF')) return { problem: 'pdf' };
    const pages = pdfPages(bin);
    if (pages !== undefined && pages > MAX_PDF_PAGES) return { problem: 'pages' };
    return { kind: 'pdf', ...(pages !== undefined ? { pages } : {}) };
  }
  if (bytes.length > MAX_TEXT_FILE_BYTES) {
    return { problem: looksBinary(bytes.subarray(0, 8192)) ? 'binary' : 'size' };
  }
  if (bytes.includes(0)) return { problem: 'binary' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { problem: 'binary' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') return { problem: 'empty' };
  return { kind: 'text', text };
}

/** Байт UTF-8 у строки. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function pathProblem(path: unknown): boolean {
  return (
    typeof path !== 'string' ||
    path.trim() === '' ||
    path.length > MAX_PATH_CHARS ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(path)
  );
}

/**
 * Проверка файла, пришедшего на хост из webview (`send.files`): тип, путь, содержимое, лимиты.
 * Размер и страницы пересчитываются по данным — webview им не верим.
 */
export function hostFile(f: unknown): PromptFile | { problem: FileProblem } {
  if (typeof f !== 'object' || f === null) return { problem: 'read' };
  const { kind, path, data } = f as Record<string, unknown>;
  if (pathProblem(path) || typeof data !== 'string') return { problem: 'read' };
  const p = (path as string).trim();
  if (kind === 'text') {
    if (data.trim() === '') return { problem: 'empty' };
    if (data.includes('\u0000')) return { problem: 'binary' };
    const size = utf8Bytes(data);
    if (size > MAX_TEXT_FILE_BYTES) return { problem: 'size' };
    return { kind, path: p, data, size };
  }
  if (kind === 'pdf') {
    if (data.length === 0) return { problem: 'empty' };
    if (data.length % 4 !== 0 || !BASE64.test(data)) return { problem: 'binary' };
    const size = base64Bytes(data);
    if (size > MAX_PDF_BYTES) return { problem: 'size' };
    let bin: string;
    try {
      bin = atob(data);
    } catch {
      return { problem: 'binary' };
    }
    if (!bin.startsWith(PDF_MAGIC)) return { problem: 'binary' };
    if (pdfEncrypted(bin)) return { problem: 'pdf' };
    const pages = pdfPages(bin);
    if (pages !== undefined && pages > MAX_PDF_PAGES) return { problem: 'pages' };
    return { kind, path: p, data, size, ...(pages !== undefined ? { pages } : {}) };
  }
  return { problem: 'read' };
}

/** Сколько символов файл занимает в сообщении (общий лимит вместе с base64 картинок). */
export function fileChars(f: { data?: string }): number {
  return f.data?.length ?? 0;
}

/**
 * Оценка токенов файла: текст — символы / 4, pdf — страницы × 1 500; страниц не знаем —
 * `undefined` («≈?» в подписи).
 */
export function fileTokens(
  f: Pick<FileRef, 'kind' | 'data' | 'size' | 'pages'>,
): number | undefined {
  if (f.kind === 'text') {
    const chars = f.data?.length ?? f.size;
    return chars === undefined ? undefined : Math.ceil(chars / 4);
  }
  return f.pages ? f.pages * PDF_PAGE_TOKENS : undefined;
}

/** Сумма оценок; `unknown` — есть файл без оценки (pdf без страниц). */
export function filesTokens(files: readonly FileRef[] | undefined): {
  tokens: number;
  unknown: boolean;
} {
  let tokens = 0;
  let unknown = false;
  for (const f of files ?? []) {
    const t = fileTokens(f);
    if (t === undefined) unknown = true;
    else tokens += t;
  }
  return { tokens, unknown };
}

/** Имя файла по пути (`/`, `\`). */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Подпись размера: «812 Б», «12 КБ», «1.4 МБ» (en: «812 B», «12 KB», «1.4 MB»). */
export function formatBytes(n: number, lang: 'ru' | 'en' = 'ru'): string {
  const [b, kb, mb] = lang === 'en' ? ['B', 'KB', 'MB'] : ['Б', 'КБ', 'МБ'];
  if (n < 1024) return `${n} ${b}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${kb}`;
  const m = n / (1024 * 1024);
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} ${mb}`;
}

/** Метка типа на значке чипа: расширение файла или `TXT`/`PDF`. */
export function fileBadge(f: Pick<FileRef, 'kind' | 'path'>): string {
  if (f.kind === 'pdf') return 'PDF';
  const ext = /\.([a-z0-9]{1,5})$/i.exec(fileName(f.path))?.[1];
  return (ext ?? 'TXT').toUpperCase();
}

/** Ключ `kind` блока в транскрипте → наш тип; не наш документ — `undefined`. */
export function documentKind(source: Record<string, unknown> | undefined): FileKind | undefined {
  if (!source) return undefined;
  if (source['type'] === 'text') return 'text';
  if (source['type'] === 'base64' && source['media_type'] === 'application/pdf') return 'pdf';
  return undefined;
}
