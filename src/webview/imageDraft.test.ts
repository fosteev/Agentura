import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BASE64 } from '../shared/images';
import { extOf, prepareImage, sourceType, transferImages, type ImageCodec } from './imageDraft';

/** Поддельный кодек: размер задан, кодирование возвращает строку заданной длины. */
function codec(
  size: { width: number; height: number },
  encoded: (type: string, quality?: number) => number = () => 1000,
) {
  const calls: unknown[][] = [];
  const c: ImageCodec = {
    decode: vi.fn(async () => size),
    encode: vi.fn(async (_mt, _d, w, h, type, quality) => {
      calls.push([w, h, type, quality]);
      return { mediaType: type, data: 'E'.repeat(encoded(type, quality)) };
    }),
  };
  return { c, calls };
}

describe('prepareImage: уменьшение и лимиты', () => {
  it('в пределах 1568 px и 5 МБ — как есть, без перекодирования (gif остаётся gif)', async () => {
    const { c, calls } = codec({ width: 640, height: 480 });
    const r = await prepareImage({ name: 'a.gif', mediaType: 'image/gif', data: 'R0lGOD' }, c);
    expect(r).toEqual({
      image: { mediaType: 'image/gif', data: 'R0lGOD', width: 640, height: 480 },
    });
    expect(calls).toEqual([]);
  });

  it('больше 1568 px — canvas до длинной стороны 1568, исходный размер запомнен', async () => {
    const { c, calls } = codec({ width: 3024, height: 1928 });
    const r = await prepareImage({ name: 'shot.png', mediaType: 'image/png', data: 'iVBOR' }, c);
    expect(calls).toEqual([[1568, 1000, 'image/png', undefined]]);
    expect(r).toMatchObject({
      image: { mediaType: 'image/png', width: 1568, height: 1000 },
      original: { width: 3024, height: 1928 },
    });
  });

  it('png после уменьшения больше 5 МБ — jpeg 0.85, затем 0.7; не влезло — ошибка размера', async () => {
    const big = codec({ width: 4000, height: 3000 }, (type, q) =>
      type === 'image/png' ? MAX_IMAGE_BASE64 + 1 : q === 0.85 ? MAX_IMAGE_BASE64 + 1 : 100,
    );
    const r = await prepareImage({ name: 'x.png', mediaType: 'image/png', data: 'iVBOR' }, big.c);
    expect(big.calls.map((x) => [x[2], x[3]])).toEqual([
      ['image/png', undefined],
      ['image/jpeg', 0.85],
      ['image/jpeg', 0.7],
    ]);
    expect(r).toMatchObject({ image: { mediaType: 'image/jpeg' } });

    const never = codec({ width: 4000, height: 3000 }, () => MAX_IMAGE_BASE64 + 1);
    expect(
      await prepareImage({ name: 'x.png', mediaType: 'image/png', data: 'iVBOR' }, never.c),
    ).toEqual({ problem: 'size' });
  });

  it('маленькая, но больше 5 МБ — перекодируется без смены размера', async () => {
    const { c, calls } = codec({ width: 1500, height: 1500 });
    const data = 'A'.repeat(MAX_IMAGE_BASE64 + 4);
    const r = await prepareImage({ name: 'x.webp', mediaType: 'image/webp', data }, c);
    expect(calls).toEqual([[1500, 1500, 'image/webp', 0.9]]);
    expect(r).not.toHaveProperty('original');
  });

  it('HEIC, svg — ошибка формата; не декодируется — «не прочитать»', async () => {
    const { c } = codec({ width: 1, height: 1 });
    expect(
      await prepareImage({ name: 'IMG_2041.heic', mediaType: 'image/heic', data: 'x' }, c),
    ).toEqual({
      problem: 'format',
    });
    expect(await prepareImage({ name: 'a.svg', mediaType: 'image/svg+xml', data: 'x' }, c)).toEqual(
      {
        problem: 'format',
      },
    );
    const broken: ImageCodec = {
      decode: async () => {
        throw new Error('decode');
      },
      encode: async () => ({ mediaType: 'image/png', data: '' }),
    };
    expect(
      await prepareImage({ name: 'a.png', mediaType: 'image/png', data: 'x' }, broken),
    ).toEqual({
      problem: 'read',
    });
  });

  it('blob читается в base64', async () => {
    const { c } = codec({ width: 2, height: 2 });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const r = await prepareImage({ name: 'image.png', mediaType: 'image/png', blob }, c);
    expect(r).toMatchObject({ image: { data: 'AQID' } });
  });
});

describe('тип и источник', () => {
  it('тип по mediaType, без него или octet-stream — по имени', () => {
    expect(sourceType({ name: 'x', mediaType: 'image/jpeg' })).toBe('image/jpeg');
    expect(sourceType({ name: 'x.webp', mediaType: '' })).toBe('image/webp');
    expect(sourceType({ name: 'x.png', mediaType: 'application/octet-stream' })).toBe('image/png');
    expect(sourceType({ name: 'x.png', mediaType: 'image/heic' })).toBeUndefined();
    expect(extOf('IMG_2041.heic')).toBe('HEIC');
    expect(extOf('', 'image/heic')).toBe('HEIC');
  });

  it('transferImages: картинки и HEIC — да, pdf — нет; без files — из items', () => {
    const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });
    const dt = {
      files: [file('a.png', 'image/png'), file('doc.pdf', 'application/pdf'), file('b.heic', '')],
    } as unknown as DataTransfer;
    expect(transferImages(dt).map((s) => s.name)).toEqual(['a.png', 'b.heic']);
    const items = {
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => file('image.png', 'image/png') },
      ],
    } as unknown as DataTransfer;
    expect(transferImages(items).map((s) => s.mediaType)).toEqual(['image/png']);
    expect(transferImages(null)).toEqual([]);
  });
});
