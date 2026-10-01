/**
 * Картинки в поле ввода (этап 4 roadmap 0.2): вставка ⌘V, перетаскивание с ⇧, «+» → файл. Каждая
 * картинка уменьшается на canvas до длинной стороны 1568 px и ≤ 5 МБ base64; исходный размер — в
 * подсказке миниатюры. Разбор и решения — чистые функции, декодирование и canvas — за `ImageCodec`
 * (в тестах подменяется: в jsdom canvas нет).
 */
import type { ImageMediaType, PromptImage } from '../agent/types';
import {
  fitImage,
  imageTypeOfName,
  isImageType,
  MAX_IMAGE_BASE64,
  sniffImageType,
  type ImageProblem,
} from '../shared/images';

/** Картинка в поле ввода: уменьшается (`busy`), готова (`image`) или с ошибкой (`problem`). */
export interface DraftImage {
  id: number;
  name: string;
  busy?: boolean;
  image?: PromptImage;
  /** Исходный размер, если картинку уменьшили. */
  original?: { width: number; height: number };
  problem?: ImageProblem;
  /** Расширение для плашки ошибки формата («HEIC»). */
  ext?: string;
}

/** Источник: файл из буфера или перетаскивания, либо base64 файла с хоста («+»). */
export interface ImageSource {
  name: string;
  mediaType?: string;
  blob?: Blob;
  data?: string;
}

export interface ImageCodec {
  /** Размер картинки; не декодируется — исключение. */
  decode(mediaType: string, data: string): Promise<{ width: number; height: number }>;
  /** Перерисовать в `width×height` и закодировать; base64 и фактический тип. */
  encode(
    mediaType: string,
    data: string,
    width: number,
    height: number,
    type: ImageMediaType,
    quality?: number,
  ): Promise<{ data: string; mediaType: string }>;
}

export type Prepared =
  { image: PromptImage; original?: { width: number; height: number } } | { problem: ImageProblem };

export function extOf(name: string, mediaType?: string): string {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  if (fromName) return fromName.toUpperCase();
  const sub = mediaType?.split('/')[1];
  return sub ? sub.toUpperCase() : '';
}

/** Имя без расширения — для подписи файла («IMG_2041»). */
export function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]{1,8}$/i, '');
}

/** Тип картинки по `type` файла или его имени; `undefined` — не наш формат. */
export function sourceType(src: ImageSource): ImageMediaType | undefined {
  if (isImageType(src.mediaType)) return src.mediaType;
  if (src.mediaType && src.mediaType !== 'application/octet-stream') return undefined;
  return imageTypeOfName(src.name);
}

/** Во что перекодировать: canvas не пишет gif — тогда png. */
export function encodeType(type: ImageMediaType): ImageMediaType {
  return type === 'image/gif' ? 'image/png' : type;
}

/**
 * Уменьшить и уложить в лимит. Картинка в пределах 1568 px и 5 МБ уходит как есть (gif остаётся
 * анимированным, png не теряет качества). Иначе — canvas в размер по длинной стороне; не влезло в
 * 5 МБ — jpeg 0.85, затем 0.7.
 */
export async function prepareImage(
  src: ImageSource,
  codec: ImageCodec = domCodec,
): Promise<Prepared> {
  const declared = sourceType(src);
  if (!declared) return { problem: 'format' };
  let data: string;
  try {
    data = src.data ?? (src.blob ? await blobBase64(src.blob) : '');
  } catch {
    return { problem: 'read' };
  }
  if (!data) return { problem: 'read' };
  // расширение и `type` бывают неверны (webp с именем `.jpg`), а API сверяет `media_type` с
  // содержимым: тип — по сигнатуре, если она наша
  const type = sniffImageType(data) ?? declared;
  let size: { width: number; height: number };
  try {
    size = await codec.decode(type, data);
  } catch {
    return { problem: 'read' };
  }
  const fit = fitImage(size.width, size.height);
  if (!fit.scaled && data.length <= MAX_IMAGE_BASE64) {
    return { image: { mediaType: type, data, width: size.width, height: size.height } };
  }
  const original = fit.scaled ? { width: size.width, height: size.height } : undefined;
  const attempts: [ImageMediaType, number | undefined][] = [
    [encodeType(type), type === 'image/png' || type === 'image/gif' ? undefined : 0.9],
    ['image/jpeg', 0.85],
    ['image/jpeg', 0.7],
  ];
  for (const [to, quality] of attempts) {
    try {
      const out = await codec.encode(type, data, fit.width, fit.height, to, quality);
      if (!isImageType(out.mediaType) || out.data.length > MAX_IMAGE_BASE64) continue;
      return {
        image: { mediaType: out.mediaType, data: out.data, width: fit.width, height: fit.height },
        ...(original ? { original } : {}),
      };
    } catch {
      return { problem: 'read' };
    }
  }
  return { problem: 'size' };
}

/** Файлы-картинки из буфера обмена или перетаскивания (`DataTransfer`). */
export function transferImages(dt: DataTransfer | null): ImageSource[] {
  if (!dt) return [];
  const out: ImageSource[] = [];
  const files = dt.files?.length
    ? Array.from(dt.files)
    : Array.from(dt.items ?? [])
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
  for (const f of files) {
    // не картинки (pdf, архив) — не наше: их «+» добавляет файлом
    if (!f.type.startsWith('image/') && !imageTypeOfName(f.name) && !/\.hei[cf]$/i.test(f.name))
      continue;
    out.push({ name: f.name || 'image.png', mediaType: f.type, blob: f });
  }
  return out;
}

/** Есть ли в перетаскиваемом файлы (подсветка поля). */
export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function loadImage(mediaType: string, data: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = `data:${mediaType};base64,${data}`;
  });
}

/** Декодирование и canvas webview. */
export const domCodec: ImageCodec = {
  async decode(mediaType, data) {
    const img = await loadImage(mediaType, data);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('decode');
    return { width: img.naturalWidth, height: img.naturalHeight };
  },
  async encode(mediaType, data, width, height, type, quality) {
    const img = await loadImage(mediaType, data);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    if (type === 'image/jpeg') {
      // у jpeg нет прозрачности: прозрачное станет белым, а не чёрным
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);
    const url = canvas.toDataURL(type, quality);
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (!m) throw new Error('encode');
    return { mediaType: m[1]!, data: m[2]! };
  },
};
