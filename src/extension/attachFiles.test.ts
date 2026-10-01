import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  attachmentFileName,
  dropAllowed,
  modelPath,
  pdfPagesDeep,
  rejected,
  parseUriList,
  readAttachment,
  workspaceTarget,
  writeAttachmentTemp,
} from './attachFiles';
import { MAX_ATTACH_FILE_BYTES } from '../shared/files';

const CWD = '/work/proj';
const src = (fsPath: string, content: Uint8Array | string, extra: object = {}) => {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { fsPath, size: bytes.length, read: async () => bytes, ...extra };
};
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = '%PDF-1.4\n<< /Type /Pages /Count 2 >>\n%%EOF';

describe('readAttachment — «+» и перетаскивание (этап 8 roadmap 0.2)', () => {
  it('текст из рабочей папки — путь относительно неё; вне её — абсолютный', async () => {
    expect(await readAttachment(CWD, src('/work/proj/docs/a.md', '# заметки'))).toEqual({
      images: [],
      files: [{ name: 'a.md', path: 'docs/a.md', kind: 'text', data: '# заметки', size: 16 }],
    });
    const out = await readAttachment(CWD, src('/tmp/x/a.txt', 'abc'));
    expect(out.files[0]).toMatchObject({ path: '/tmp/x/a.txt', kind: 'text' });
  });

  it('pdf — base64 и страницы; картинка — путём этапа 4 (image.picked), даже с чужим расширением', async () => {
    const pdf = await readAttachment(CWD, src('/work/proj/spec.pdf', PDF));
    expect(pdf.files[0]).toEqual({
      name: 'spec.pdf',
      path: 'spec.pdf',
      kind: 'pdf',
      data: Buffer.from(PDF).toString('base64'),
      size: PDF.length,
      pages: 2,
    });
    const img = await readAttachment(CWD, src('/work/proj/shot.dat', PNG));
    expect(img).toEqual({
      images: [
        { name: 'shot.dat', mediaType: 'image/png', data: Buffer.from(PNG).toString('base64') },
      ],
      files: [],
    });
  });

  it('папка, двоичный, без stat, больше 30 МБ, ошибка чтения — плашки с причиной; файл не читается зря', async () => {
    let reads = 0;
    const counted = (fsPath: string, extra: object) =>
      src(fsPath, 'x', {
        read: async () => {
          reads++;
          return new Uint8Array([1]);
        },
        ...extra,
      });
    expect((await readAttachment(CWD, counted('/work/proj/src', { isDir: true }))).files).toEqual([
      { name: 'src', problem: 'folder' },
    ]);
    expect(
      (await readAttachment(CWD, counted('/work/proj/a.txt', { size: undefined }))).files,
    ).toEqual([{ name: 'a.txt', problem: 'read' }]);
    expect(
      (await readAttachment(CWD, counted('/work/proj/a.iso', { size: MAX_ATTACH_FILE_BYTES + 1 })))
        .files,
    ).toEqual([{ name: 'a.iso', problem: 'size' }]);
    expect(reads).toBe(0);
    expect(
      (await readAttachment(CWD, src('/work/proj/app.bin', Uint8Array.from([0, 1, 2])))).files,
    ).toEqual([{ name: 'app.bin', problem: 'binary' }]);
    const broken = await readAttachment(
      CWD,
      src('/work/proj/a.txt', 'x', {
        read: async () => {
          throw new Error('EACCES');
        },
      }),
    );
    expect(broken.files).toEqual([{ name: 'a.txt', problem: 'read' }]);
  });

  it('HEIC и svg — плашка картинки «не берём» (как в этапе 4), не текст', async () => {
    expect(await readAttachment(CWD, src('/p/IMG.heic', Uint8Array.from([0, 0, 0, 24])))).toEqual({
      images: [{ name: 'IMG.heic', problem: 'format' }],
      files: [],
    });
    expect((await readAttachment(CWD, src('/p/logo.svg', '<svg/>'))).images).toEqual([
      { name: 'logo.svg', problem: 'format' },
    ]);
    expect((await readAttachment(CWD, src('/p/broken.png', 'not png'))).images[0]).toMatchObject({
      name: 'broken.png',
      problem: 'format',
    });
  });
});

describe('pdf, который API не примет (приёмка этапа 8)', () => {
  // pdf 1.5+: дерево страниц и сами страницы — в сжатом потоке объектов, в сыром файле их не видно
  const objStmPdf = (pages: number): Uint8Array => {
    const body = deflateSync(
      Buffer.from(
        `<< /Type /Pages /Count ${pages} /Kids [] >> ` + '<< /Type /Page >> '.repeat(pages),
      ),
    );
    return Buffer.concat([
      Buffer.from('%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 3 /First 9 /Filter /FlateDecode >>\nstream\r\n'),
      body,
      Buffer.from('\r\nendstream\nendobj\n%%EOF'),
    ]);
  };

  it('страницы считаются и в сжатых потоках объектов; больше 100 — плашка', async () => {
    expect(pdfPagesDeep(objStmPdf(3))).toBe(3);
    const ok = await readAttachment(CWD, src('/work/proj/a.pdf', objStmPdf(3)));
    expect(ok.files[0]).toMatchObject({ kind: 'pdf', pages: 3 });
    const big = await readAttachment(CWD, src('/work/proj/b.pdf', objStmPdf(150)));
    expect(big.files).toEqual([{ name: 'b.pdf', problem: 'pages' }]);
  });

  it('страниц не найти или pdf зашифрован — плашка «pdf не читается», а не отказ API в сессии', async () => {
    const none = await readAttachment(CWD, src('/work/proj/c.pdf', '%PDF-1.7\ngarbage\n%%EOF'));
    expect(none.files).toEqual([{ name: 'c.pdf', problem: 'pdf' }]);
    const enc = await readAttachment(
      CWD,
      src('/work/proj/d.pdf', `${PDF}\ntrailer << /Root 1 0 R /Encrypt 9 0 R >>`),
    );
    expect(enc.files).toEqual([{ name: 'd.pdf', problem: 'pdf' }]);
  });
});

describe('rejected — плашка по имени файла', () => {
  it('картинка сверх потолка «+» — плашка картинки total, вне рабочей папки — плашка файла', () => {
    expect(rejected('a.png', 'total')).toEqual({
      images: [{ name: 'a.png', mediaType: 'image/png', problem: 'total' }],
      files: [],
    });
    expect(rejected('a.png', 'outside')).toEqual({
      images: [],
      files: [{ name: 'a.png', problem: 'outside' }],
    });
  });
});

describe('пути', () => {
  it('dropAllowed: только внутри папок воркспейса; соседняя папка с тем же префиксом и ~/.ssh — нет', () => {
    const roots = ['/work/proj', '/work/lib'];
    expect(dropAllowed('/work/proj/a/b.ts', roots)).toBe(true);
    expect(dropAllowed('/work/lib/x.md', roots)).toBe(true);
    expect(dropAllowed('/work/proj2/a.ts', roots)).toBe(false);
    expect(dropAllowed('/Users/me/.ssh/id_rsa', roots)).toBe(false);
    expect(dropAllowed('/work/proj', roots)).toBe(false);
    expect(dropAllowed('/work/proj/../secret', roots)).toBe(false);
    expect(dropAllowed('/home/u/repo/a.ts', ['/home/u/repo'], true)).toBe(true);
    expect(dropAllowed('/home/u/.ssh/id_rsa', ['/home/u/repo'], true)).toBe(false);
    expect(dropAllowed('/a.ts', [])).toBe(false);
  });

  it('modelPath: внутри — относительный с /, снаружи и соседняя папка с тем же префиксом — абсолютный', () => {
    expect(modelPath(CWD, '/work/proj/a/b.ts')).toBe('a/b.ts');
    expect(modelPath(CWD, '/work/proj2/a.ts')).toBe('/work/proj2/a.ts');
    expect(modelPath(CWD, '/etc/hosts')).toBe('/etc/hosts');
  });

  it('workspaceTarget: только относительный путь внутри папки', () => {
    expect(workspaceTarget(CWD, 'a/b.ts')).toBe('/work/proj/a/b.ts');
    expect(workspaceTarget(CWD, '../secret')).toBeUndefined();
    expect(workspaceTarget(CWD, 'a/../../x')).toBeUndefined();
    expect(workspaceTarget(CWD, '/etc/hosts')).toBeUndefined();
    expect(workspaceTarget(CWD, 'C:\\x')).toBeUndefined();
    expect(workspaceTarget(CWD, '')).toBeUndefined();
  });

  it('parseUriList: строки, комментарии, дубли, не строки, лимит', () => {
    expect(parseUriList(['file:///a\r\n# c\nfile:///b\n', 'file:///a', 3 as never])).toEqual([
      'file:///a',
      'file:///b',
    ]);
    expect(parseUriList(['file:///1\nfile:///2\nfile:///3'], 2)).toEqual([
      'file:///1',
      'file:///2',
    ]);
  });
});

describe('временная копия файла вне рабочей папки', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('имя — исходное + хэш; текст UTF-8, pdf из base64; повторный клик — тот же файл', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentura-attach-test-'));
    const a = await writeAttachmentTemp(dir, {
      kind: 'text',
      path: '/x/заметки.md',
      data: 'привет',
    });
    expect(a).toMatch(/заметки-[0-9a-f]{12}\.md$/);
    expect(readFileSync(a, 'utf8')).toBe('привет');
    const b = await writeAttachmentTemp(dir, {
      kind: 'pdf',
      path: '/x/spec',
      data: Buffer.from(PDF).toString('base64'),
    });
    expect(b.endsWith('.pdf')).toBe(true);
    expect(readFileSync(b, 'latin1')).toBe(PDF);
    expect(
      await writeAttachmentTemp(dir, { kind: 'text', path: '/x/заметки.md', data: 'привет' }),
    ).toBe(a);
    expect(readdirSync(dir)).toHaveLength(2);
    expect(attachmentFileName({ kind: 'text', path: 'a/b<c>.txt', data: '1' })).toMatch(/^b_c_-/);
  });
});
