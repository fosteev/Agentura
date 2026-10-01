import { describe, expect, it } from 'vitest';
import {
  base64Bytes,
  fitImage,
  hostImage,
  imageProblem,
  imageSize,
  imageTokens,
  imagesTokens,
  imageTypeOfName,
  isImageType,
  MAX_IMAGE_BASE64,
  sniffImageType,
} from './images';

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

describe('форматы и лимиты', () => {
  it('png/jpeg/gif/webp — да, heic/svg — нет; тип по имени', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp'].every(isImageType)).toBe(true);
    expect(isImageType('image/heic')).toBe(false);
    expect(isImageType('image/svg+xml')).toBe(false);
    expect(imageTypeOfName('Снимок экрана.PNG')).toBe('image/png');
    expect(imageTypeOfName('a.jpeg')).toBe('image/jpeg');
    expect(imageTypeOfName('IMG_2041.heic')).toBeUndefined();
  });

  it('imageProblem: формат, пусто, больше 5 МБ base64', () => {
    expect(imageProblem({ mediaType: 'image/png', data: 'AAAA' })).toBeUndefined();
    expect(imageProblem({ mediaType: 'image/heic', data: 'AAAA' })).toBe('format');
    expect(imageProblem({ mediaType: 'image/png', data: '' })).toBe('size');
    expect(imageProblem({ mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64 + 4) })).toBe(
      'size',
    );
    expect(imageProblem({ mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64) })).toBe(
      undefined,
    );
  });

  it('sniffImageType: формат по сигнатуре, не по имени', () => {
    expect(sniffImageType(b64([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('image/png');
    expect(sniffImageType(b64([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toBe('image/jpeg');
    expect(sniffImageType(b64([...'GIF89a'].map((c) => c.charCodeAt(0))))).toBe('image/gif');
    expect(sniffImageType(b64([...'RIFF\0\0\0\0WEBPVP8 '].map((c) => c.charCodeAt(0))))).toBe(
      'image/webp',
    );
    expect(sniffImageType(btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImageType('')).toBeUndefined();
  });

  it('hostImage: тип исправляется по содержимому; не base64, data:-префикс, не картинка — format', () => {
    const png = b64([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);
    expect(hostImage({ mediaType: 'image/jpeg', data: png })).toEqual({ mediaType: 'image/png' });
    expect(hostImage({ mediaType: 'image/png', data: `data:image/png;base64,${png}` })).toEqual({
      problem: 'format',
    });
    expect(hostImage({ mediaType: 'image/png', data: png.slice(0, -1) })).toEqual({
      problem: 'format',
    });
    expect(hostImage({ mediaType: 'image/png', data: btoa('hello world!') })).toEqual({
      problem: 'format',
    });
    expect(hostImage({ mediaType: 'image/heic', data: png })).toEqual({ problem: 'format' });
    expect(hostImage({ mediaType: 'image/png', data: '' })).toEqual({ problem: 'size' });
  });

  it('base64Bytes учитывает «=»', () => {
    expect(base64Bytes(btoa('abc'))).toBe(3);
    expect(base64Bytes(btoa('ab'))).toBe(2);
    expect(base64Bytes(btoa('a'))).toBe(1);
  });
});

describe('уменьшение и токены', () => {
  it('fitImage: длинная сторона ≤ 1568, пропорции сохраняются; маленькие не трогаем', () => {
    expect(fitImage(3024, 1928)).toEqual({ width: 1568, height: 1000, scaled: true });
    expect(fitImage(1000, 4000)).toEqual({ width: 392, height: 1568, scaled: true });
    expect(fitImage(1568, 1000)).toEqual({ width: 1568, height: 1000, scaled: false });
    expect(fitImage(10000, 1)).toMatchObject({ width: 1568, height: 1 });
  });

  it('токены: ш×в/750 вверх; список — сумма, без размера не считается', () => {
    expect(imageTokens(1568, 1000)).toBe(2091); // «~2.1k» прототипа
    expect(imageTokens(1200, 764)).toBe(1223);
    expect(imagesTokens([{ width: 1568, height: 1000 }, { width: 1200, height: 764 }, {}])).toBe(
      3314,
    );
    expect(imagesTokens(undefined)).toBe(0);
  });
});

describe('imageSize: размер по заголовку файла', () => {
  it('png (IHDR)', () => {
    const png = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ];
    expect(
      imageSize('image/png', b64([...png, ...be32(1568), ...be32(1000), 8, 2, 0, 0, 0])),
    ).toEqual({ width: 1568, height: 1000 });
  });

  it('gif', () => {
    expect(
      imageSize(
        'image/gif',
        b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(640), ...le16(480), 0]),
      ),
    ).toEqual({ width: 640, height: 480 });
  });

  it('jpeg: SOF после APP0', () => {
    const app0 = [0xff, 0xe0, 0, 16, ...new Array(14).fill(0)];
    // SOF0: длина 17, точность 8, высота 0x02d0 = 720, ширина 0x0500 = 1280
    const sof = [0xff, 0xc0, 0, 17, 8, 0x02, 0xd0, 0x05, 0x00, 3, ...new Array(9).fill(0)];
    expect(imageSize('image/jpeg', b64([0xff, 0xd8, ...app0, ...sof]))).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('webp: VP8X и VP8L', () => {
    const riff = (kind: string, body: number[]) => [
      ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
      ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
      ...kind.split('').map((c) => c.charCodeAt(0)),
      ...body,
    ];
    expect(
      imageSize(
        'image/webp',
        b64(riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, ...le24(799), ...le24(599)])),
      ),
    ).toEqual({
      width: 800,
      height: 600,
    });
    // VP8L: 14 бит ширины-1, 14 бит высоты-1 после байта сигнатуры 0x2f
    const bits = 99 | (49 << 14);
    expect(
      imageSize(
        'image/webp',
        b64(
          riff('VP8L', [
            0,
            0,
            0,
            0,
            0x2f,
            bits & 255,
            (bits >>> 8) & 255,
            (bits >>> 16) & 255,
            (bits >>> 24) & 255,
            0,
            0,
            0,
          ]),
        ),
      ),
    ).toEqual({ width: 100, height: 50 });
  });

  it('мусор — undefined', () => {
    expect(imageSize('image/png', 'не base64 вовсе')).toBeUndefined();
    expect(imageSize('image/png', '')).toBeUndefined();
  });
});
