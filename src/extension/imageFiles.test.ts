import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_FILE_BYTES } from '../shared/images';
import { imageFileName, pickedImage, pruneImages, writeImageTemp } from './imageFiles';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'agentura-images-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('временные файлы картинок (просмотр миниатюры)', () => {
  it('имя по хэшу данных и расширению типа; повторная запись — тот же файл', async () => {
    const dir = join(tmp(), 'images');
    const img = { mediaType: 'image/png' as const, data: Buffer.from('png!').toString('base64') };
    const a = await writeImageTemp(dir, img);
    const b = await writeImageTemp(dir, img);
    expect(a).toBe(b);
    expect(a.endsWith('.png')).toBe(true);
    expect(readFileSync(a, 'utf8')).toBe('png!');
    expect(readdirSync(dir)).toHaveLength(1);
    expect(imageFileName('image/jpeg', 'x')).toMatch(/^[0-9a-f]{20}\.jpg$/);
  });

  it('pruneImages оставляет самые свежие', async () => {
    const dir = tmp();
    for (let i = 0; i < 5; i++) {
      const p = await writeImageTemp(dir, { mediaType: 'image/png', data: btoa(`img${i}`) });
      utimesSync(p, 1000 + i, 1000 + i);
    }
    await pruneImages(dir, 2);
    const left = readdirSync(dir).map((n) => readFileSync(join(dir, n), 'utf8'));
    expect(left.sort()).toEqual(['img3', 'img4']);
  });
});

describe('pickedImage («+» → файл)', () => {
  it('картинка — base64; другой формат и слишком большой файл — без чтения', async () => {
    let reads = 0;
    const read = async () => {
      reads++;
      return new Uint8Array([1, 2, 3]);
    };
    expect(await pickedImage('a.png', 3, read)).toEqual({
      name: 'a.png',
      mediaType: 'image/png',
      data: 'AQID',
    });
    expect(await pickedImage('IMG.heic', 3, read)).toEqual({ name: 'IMG.heic', problem: 'format' });
    expect(await pickedImage('big.jpg', MAX_IMAGE_FILE_BYTES + 1, read)).toMatchObject({
      problem: 'size',
    });
    expect(reads).toBe(1);
    expect(
      await pickedImage('a.webp', 3, async () => {
        throw new Error('EACCES');
      }),
    ).toMatchObject({ problem: 'read' });
  });
});
