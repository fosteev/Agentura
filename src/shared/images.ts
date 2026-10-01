/**
 * Картинки в сообщении (этап 4 roadmap 0.2): форматы, лимиты, оценка токенов, размер по заголовку
 * файла. Чистые функции — ими пользуются webview (вставка), хост (проверка, «+») и история.
 */
import type { ImageMediaType, ImageRef } from '../agent/types';

export const IMAGE_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
/** Расширения для диалога «+» и временных файлов просмотра. */
export const IMAGE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
/** Фильтр диалога «+». */
export const IMAGE_EXTENSION_LIST: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
/** Длинная сторона после уменьшения: больше API всё равно ужимает сам. */
export const MAX_IMAGE_SIDE = 1568;
/** Лимит API на картинку — 5 МБ base64. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
/** Картинок в одном сообщении (решение этапа 4: больше — неудобно и тяжело для запроса). */
export const MAX_IMAGES_PER_MESSAGE = 10;
/**
 * Все картинки одного сообщения вместе, base64: лимит запроса к API — 32 МБ, а 10 × 5 МБ его
 * превысили бы (отказ остался бы в транскрипте и ронял бы каждый следующий ход).
 */
export const MAX_MESSAGE_IMAGES_BASE64 = 20 * 1024 * 1024;
/** Файл с диска («+») больше этого не читаем: уменьшать такой незачем и долго. */
export const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024;

export function isImageType(type: string | undefined): type is ImageMediaType {
  return IMAGE_TYPES.includes(type as ImageMediaType);
}

/** Тип по имени файла (диалог «+», перетаскивание без `type`). */
export function imageTypeOfName(name: string): ImageMediaType | undefined {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return undefined;
}

/** Оценка токенов картинки, как в документации API: ширина × высота / 750. */
export function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

/** Оценка по списку; картинки без размера не считаются. */
export function imagesTokens(images: readonly ImageRef[] | undefined): number {
  let sum = 0;
  for (const i of images ?? []) {
    if (i.width && i.height) sum += imageTokens(i.width, i.height);
  }
  return sum;
}

/** Размер после уменьшения до `max` по длинной стороне (пропорционально, целые px). */
export function fitImage(
  width: number,
  height: number,
  max = MAX_IMAGE_SIDE,
): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height, scaled: false };
  const k = max / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
    scaled: true,
  };
}

/** Байт исходных данных у base64 (без декодирования). */
export function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

/** Первые `n` байт base64 (для разбора заголовка). */
function head(data: string, n: number): Uint8Array {
  const chunk = data.slice(0, Math.ceil(n / 3) * 4 + 8).replace(/[^A-Za-z0-9+/=]/g, '');
  const trimmed = chunk.slice(0, chunk.length - (chunk.length % 4));
  let bin: string;
  try {
    bin = atob(trimmed);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Ширина и высота по заголовку файла (png, gif, webp, jpeg). Нужна истории: транскрипт хранит
 * только base64. Нет — `undefined` (повреждённые данные, экзотический jpeg с SOF дальше 64 кБ).
 */
export function imageSize(
  mediaType: string | undefined,
  data: string,
): { width: number; height: number } | undefined {
  const b = head(data, mediaType === 'image/jpeg' ? 65536 : 32);
  const u16be = (i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  const u16le = (i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
  const u24le = (i: number): number => u16le(i) | ((b[i + 2] ?? 0) << 16);
  const u32be = (i: number): number => u16be(i) * 65536 + u16be(i + 2);
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : undefined);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return ok(u32be(16), u32be(20));
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return ok(u16le(6), u16le(8));
  }
  if (b.length >= 16 && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === 'VP8X') return ok(u24le(24) + 1, u24le(27) + 1);
    if (kind === 'VP8 ') return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (kind === 'VP8L') {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1] ?? 0;
      // SOF0…SOF15 кроме DHT (C4), JPG (C8), DAC (CC)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return ok(u16be(i + 7), u16be(i + 5));
      }
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

/**
 * Формат по сигнатуре данных (png, jpeg, gif, webp); `undefined` — не картинка или не наш формат.
 * Расширение файла и `type` из буфера бывают неверны (webp с именем `.jpg`), а API отвергает
 * картинку, чей `media_type` не совпал с содержимым, — ход падает с 400.
 */
export function sniffImageType(data: string): ImageMediaType | undefined {
  const b = head(data, 12);
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && String.fromCharCode(...b.slice(0, 4)) === 'GIF8') return 'image/gif';
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Проверка картинки, пришедшей на хост снаружи (webview): лимиты `imageProblem`, строгий base64
 * без `data:`-префикса и пробелов, формат по сигнатуре. Тип исправляется на фактический (API
 * сверяет `media_type` с содержимым); сигнатура не наша — `format`.
 */
export function hostImage(i: {
  mediaType: string;
  data: string;
}): { mediaType: ImageMediaType } | { problem: ImageProblem } {
  const problem = imageProblem(i);
  if (problem) return { problem };
  if (i.data.length % 4 !== 0 || !BASE64.test(i.data)) return { problem: 'format' };
  const sniffed = sniffImageType(i.data);
  return sniffed ? { mediaType: sniffed } : { problem: 'format' };
}

/** Ошибка вложения для красной плашки (`undefined` — картинка годится). */
export type ImageProblem = 'format' | 'size' | 'count' | 'total' | 'read' | 'session' | 'context';

/** Проверка готовой картинки перед отправкой (webview — до плашки, хост — ещё раз). */
export function imageProblem(i: { mediaType: string; data: string }): ImageProblem | undefined {
  if (!isImageType(i.mediaType)) return 'format';
  if (i.data.length === 0 || i.data.length > MAX_IMAGE_BASE64) return 'size';
  return undefined;
}
