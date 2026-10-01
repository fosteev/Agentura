import { describe, expect, it } from 'vitest';
import {
  attachFileTokens,
  attachTokenBudget,
  classifyBytes,
  fileBadge,
  fileName,
  filesTokens,
  fileTokens,
  formatBytes,
  hostFile,
  MAX_PDF_BYTES,
  MAX_TEXT_FILE_BYTES,
  MAX_SESSION_ATTACH_CHARS,
  pdfPages,
  sessionPdfPages,
  sessionProblem,
} from './files';

const bytes = (s: string) => new TextEncoder().encode(s);
const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const pdf = (pages: number) =>
  `%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] /Count ${pages} >> endobj\n` +
  Array.from({ length: Math.min(pages, 3) }, () => '<< /Type /Page /Parent 1 0 R >>').join('\n') +
  '\n%%EOF';

describe('classifyBytes — тип по содержимому (этап 8 roadmap 0.2)', () => {
  it('текст UTF-8 (BOM снят), картинка по сигнатуре, pdf по %PDF-', () => {
    expect(classifyBytes(bytes('\uFEFFпривет\n'))).toEqual({ kind: 'text', text: 'привет\n' });
    expect(classifyBytes(Uint8Array.from(PNG_HEAD))).toEqual({
      kind: 'image',
      mediaType: 'image/png',
    });
    expect(classifyBytes(latin(pdf(2)))).toEqual({ kind: 'pdf', pages: 2 });
  });

  it('двоичный: NUL-байт, невалидный UTF-8; пустой и из пробелов — empty', () => {
    expect(classifyBytes(bytes('a\u0000b'))).toEqual({ problem: 'binary' });
    expect(classifyBytes(Uint8Array.from([0xc3, 0x28]))).toEqual({ problem: 'binary' });
    expect(classifyBytes(new Uint8Array())).toEqual({ problem: 'empty' });
    expect(classifyBytes(bytes(' \n\t'))).toEqual({ problem: 'empty' });
  });

  it('лимиты: текст больше 256 КБ — size, такой же двоичный — binary; pdf больше 15 МБ и 100 страниц', () => {
    expect(classifyBytes(bytes('a'.repeat(MAX_TEXT_FILE_BYTES)))).toMatchObject({ kind: 'text' });
    expect(classifyBytes(bytes('a'.repeat(MAX_TEXT_FILE_BYTES + 1)))).toEqual({ problem: 'size' });
    const bin = new Uint8Array(MAX_TEXT_FILE_BYTES + 1);
    expect(classifyBytes(bin)).toEqual({ problem: 'binary' });
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    big.set(latin('%PDF-'));
    expect(classifyBytes(big)).toEqual({ problem: 'size' });
    expect(classifyBytes(latin(pdf(101)))).toEqual({ problem: 'pages' });
  });

  it('pdf обрезан (нет %%EOF в конце) или зашифрован — pdf (API не примет, приёмка этапа 8)', () => {
    expect(classifyBytes(latin(pdf(2).replace('%%EOF', '')))).toEqual({ problem: 'pdf' });
    expect(classifyBytes(latin(`${pdf(2)}\ntrailer << /Encrypt 5 0 R >>\n%%EOF`))).toEqual({
      problem: 'pdf',
    });
  });
});

describe('pdfPages', () => {
  it('наибольший /Count дерева (или /N линеаризации), без него — число объектов /Page; не посчитать — undefined', () => {
    expect(pdfPages(pdf(5))).toBe(5);
    expect(pdfPages('<< /Count 3 /Type /Pages >> << /Type /Page >>')).toBe(3);
    // инкрементальное сохранение: старая версия страницы осталась в файле — верим /Count (приёмка этапа 8)
    expect(pdfPages('<< /Type /Page >> << /Type /Page >> << /Type /Pages /Count 1 >>')).toBe(1);
    expect(pdfPages('<< /Type /Page >> << /Type /Page >>')).toBe(2);
    expect(pdfPages('<< /Linearized 1 /L 9 /N 7 /T 5 >>')).toBe(7);
    expect(pdfPages('%PDF-1.7 сжатые потоки')).toBeUndefined();
  });
});

describe('hostFile — перепроверка send.files на хосте', () => {
  it('текст: размер пересчитан по UTF-8, путь обрезан от пробелов', () => {
    expect(hostFile({ kind: 'text', path: ' a/b.txt ', data: 'ы', size: 999 })).toEqual({
      kind: 'text',
      path: 'a/b.txt',
      data: 'ы',
      size: 2,
    });
  });

  it('текст: NUL, пустой, больше 256 КБ, без пути и с переводом строки в пути — отказ', () => {
    expect(hostFile({ kind: 'text', path: 'a', data: 'a\u0000' })).toEqual({ problem: 'binary' });
    expect(hostFile({ kind: 'text', path: 'a', data: '  ' })).toEqual({ problem: 'empty' });
    expect(
      hostFile({ kind: 'text', path: 'a', data: 'ы'.repeat(MAX_TEXT_FILE_BYTES / 2 + 1) }),
    ).toEqual({ problem: 'size' });
    expect(hostFile({ kind: 'text', path: '', data: 'a' })).toEqual({ problem: 'read' });
    expect(hostFile({ kind: 'text', path: 'a\nb', data: 'a' })).toEqual({ problem: 'read' });
    expect(hostFile({ kind: 'html', path: 'a', data: 'a' })).toEqual({ problem: 'read' });
    expect(hostFile(null)).toEqual({ problem: 'read' });
  });

  it('pdf: строгий base64 с %PDF-, страницы пересчитаны; не pdf и не base64 — binary', () => {
    const data = btoa(pdf(2));
    expect(hostFile({ kind: 'pdf', path: '/x.pdf', data, pages: 50 })).toEqual({
      kind: 'pdf',
      path: '/x.pdf',
      data,
      size: pdf(2).length,
      pages: 2,
    });
    expect(hostFile({ kind: 'pdf', path: 'x', data: btoa('<html>') })).toEqual({
      problem: 'binary',
    });
    expect(
      hostFile({ kind: 'pdf', path: 'x', data: `data:application/pdf;base64,${data}` }),
    ).toEqual({ problem: 'binary' });
    expect(hostFile({ kind: 'pdf', path: 'x', data: btoa(pdf(101)) })).toEqual({
      problem: 'pages',
    });
    // зашифрованный — не в движок: отказ API остался бы в транскрипте (приёмка этапа 8)
    const enc = btoa(`${pdf(2)}\ntrailer\n<< /Size 9 /Encrypt << /Filter /Standard >> >>`);
    expect(hostFile({ kind: 'pdf', path: 'x', data: enc })).toEqual({ problem: 'pdf' });
  });
});

describe('оценка и подписи', () => {
  it('токены: текст — символы / 4, pdf — 1 500 на страницу, без страниц — неизвестно', () => {
    expect(fileTokens({ kind: 'text', data: 'a'.repeat(4001) })).toBe(1001);
    expect(fileTokens({ kind: 'text', size: 400 })).toBe(100);
    expect(fileTokens({ kind: 'pdf', pages: 3 })).toBe(4500);
    expect(fileTokens({ kind: 'pdf' })).toBeUndefined();
    expect(
      filesTokens([
        { kind: 'text', path: 'a', data: 'abcd' },
        { kind: 'pdf', path: 'b' },
      ]),
    ).toEqual({ tokens: 1, unknown: true });
  });

  it('имя, значок, размер', () => {
    expect(fileName('a/b/c.ts')).toBe('c.ts');
    expect(fileName('C:\\x\\y.md')).toBe('y.md');
    expect(fileBadge({ kind: 'text', path: 'src/app.tsx' })).toBe('TSX');
    expect(fileBadge({ kind: 'text', path: 'Makefile' })).toBe('TXT');
    expect(fileBadge({ kind: 'pdf', path: 'x.PDF' })).toBe('PDF');
    expect(formatBytes(812)).toBe('812 Б');
    expect(formatBytes(12 * 1024)).toBe('12 КБ');
    expect(formatBytes(1.4 * 1024 * 1024)).toBe('1.4 МБ');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 МБ');
  });
});

describe('лимиты API на сессию (этап 6 roadmap 0.2)', () => {
  it('sessionProblem: 100 страниц pdf и 24 МБ тела запроса на всю историю', () => {
    expect(sessionProblem({ pdfPages: 60, chars: 0 }, { pages: 40, chars: 10 })).toBeUndefined();
    expect(sessionProblem({ pdfPages: 60, chars: 0 }, { pages: 41, chars: 10 })).toBe(
      'sessionPages',
    );
    expect(sessionProblem({ pdfPages: 0, chars: MAX_SESSION_ATTACH_CHARS - 5 }, { chars: 5 })).toBe(
      undefined,
    );
    expect(sessionProblem({ pdfPages: 0, chars: MAX_SESSION_ATTACH_CHARS - 5 }, { chars: 6 })).toBe(
      'session',
    );
    // страницы важнее размера, если нарушены оба
    expect(
      sessionProblem({ pdfPages: 100, chars: MAX_SESSION_ATTACH_CHARS }, { pages: 1, chars: 1 }),
    ).toBe('sessionPages');
  });

  it('sessionPdfPages: известные страницы, иначе по размеру; текст — 0', () => {
    expect(sessionPdfPages({ kind: 'pdf', size: 1, pages: 7 })).toBe(7);
    expect(sessionPdfPages({ kind: 'pdf', size: 120_000 })).toBe(3);
    expect(sessionPdfPages({ kind: 'pdf', size: 10 })).toBe(1);
    expect(sessionPdfPages({ kind: 'text', size: 10 })).toBe(0);
  });

  it('attachFileTokens: pdf без числа страниц — по оценке страниц из размера, а не ноль', () => {
    expect(attachFileTokens({ kind: 'pdf', data: 'x', size: 120_000 })).toBe(3 * 1500);
    expect(attachFileTokens({ kind: 'pdf', data: 'x', size: 1, pages: 2 })).toBe(3000);
    expect(attachFileTokens({ kind: 'text', data: 'x'.repeat(8), size: 8 })).toBe(2);
  });

  it('attachTokenBudget: 70 % свободного окна; окно неизвестно — 200k; занято всё — 0', () => {
    expect(attachTokenBudget(200_000, 160_000)).toBe(28_000);
    expect(attachTokenBudget(undefined, undefined)).toBe(140_000);
    expect(attachTokenBudget(1_000_000, 0)).toBe(700_000);
    expect(attachTokenBudget(200_000, 250_000)).toBe(0);
  });
});
