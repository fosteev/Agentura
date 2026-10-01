/**
 * Картинки на стороне хоста (этап 4 roadmap 0.2), без `vscode`: временные файлы для просмотра
 * миниатюры во вкладке редактора и разбор файла, выбранного через «+». Временные файлы — в
 * `globalStorageUri/images` расширения, не в рабочей папке; имя — по хэшу данных (повторный клик не
 * плодит копий), старые сверх `KEEP_IMAGES` удаляются.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageMediaType } from '../agent/types';
import type { PickedImage } from '../protocol';
import { IMAGE_EXTENSIONS, imageTypeOfName, MAX_IMAGE_FILE_BYTES } from '../shared/images';

/** Сколько временных картинок хранить. */
export const KEEP_IMAGES = 50;

export function imageFileName(mediaType: ImageMediaType, data: string): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 20);
  return `${hash}.${IMAGE_EXTENSIONS[mediaType]}`;
}

/** Записать картинку (base64) во временную папку; путь к файлу. */
export async function writeImageTemp(
  dir: string,
  image: { mediaType: ImageMediaType; data: string },
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, imageFileName(image.mediaType, image.data));
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await writeFile(path, Buffer.from(image.data, 'base64'));
    await pruneImages(dir).catch(() => undefined);
  }
  return path;
}

/** Оставить `keep` самых свежих файлов папки. */
export async function pruneImages(dir: string, keep = KEEP_IMAGES): Promise<void> {
  const names = await readdir(dir);
  if (names.length <= keep) return;
  const files = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(keep)) await unlink(join(dir, f.name)).catch(() => undefined);
}

/**
 * Выбранный файл → `PickedImage`. Формат — по имени (диалог фильтрует, но «все файлы» никто не
 * запрещал), размер — до чтения: файл больше `MAX_IMAGE_FILE_BYTES` не читаем.
 */
export async function pickedImage(
  name: string,
  size: number,
  read: () => Promise<Uint8Array>,
): Promise<PickedImage> {
  const mediaType = imageTypeOfName(name);
  if (!mediaType) return { name, problem: 'format' };
  if (size > MAX_IMAGE_FILE_BYTES) return { name, mediaType, problem: 'size' };
  try {
    const bytes = await read();
    return { name, mediaType, data: Buffer.from(bytes).toString('base64') };
  } catch {
    return { name, mediaType, problem: 'read' };
  }
}
