// @vitest-environment jsdom
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './components/Composer';
import { Log } from './components/Log';
import {
  addFiles,
  capabilities,
  chat,
  draftFiles,
  draftImages,
  editor,
  extra,
  handleHostMessage,
  history,
  hudState,
  limits,
  openFile,
  sendMessage,
  sessionAttach,
} from './store';
import { initialHud } from './hudState';
import { applyEvent, initialState, queueUser, type FeedRow } from './chatState';
import { transferUris } from './imageDraft';
import { MAX_MESSAGE_ATTACH_CHARS } from '../shared/files';
import * as vscode from './vscode';

const posted: { type: string; [k: string]: unknown }[] = [];

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  render(h(Composer, {}), host);
  return host;
}
const flush = () => new Promise((r) => setTimeout(r, 30));

function typeText(host: HTMLElement, text: string) {
  const ed = host.querySelector<HTMLElement>('.typed')!;
  ed.focus();
  ed.textContent = text;
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  return ed;
}

function enter(el: HTMLElement) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

/** `DataTransfer` перетаскивания из проводника VS Code: только типы и строки, файлов нет. */
function uriTransfer(data: Record<string, string>, files: File[] = []): DataTransfer {
  return {
    files,
    items: [],
    types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
    getData: (t: string) => data[t] ?? '',
  } as unknown as DataTransfer;
}

function drag(host: HTMLElement, type: string, dt: DataTransfer) {
  const f = host.querySelector<HTMLElement>('footer.compose')!;
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  f.dispatchEvent(e);
  return e;
}

const TXT = {
  name: 'notes.txt',
  path: 'docs/notes.txt',
  kind: 'text' as const,
  data: 'x'.repeat(4000),
  size: 4000,
};
const PDF = {
  name: 'spec.pdf',
  path: '/abs/spec.pdf',
  kind: 'pdf' as const,
  data: 'JVBERi0x',
  size: 6,
};

beforeEach(() => {
  document.body.innerHTML = '';
  posted.length = 0;
  vi.spyOn(vscode, 'send').mockImplementation((m) => void posted.push(m as never));
  chat.value = { ...initialState(), project: 'p', cwd: '/p' };
  capabilities.value = { models: [], commands: [] };
  editor.value = {};
  extra.value = [];
  history.value = [];
  draftImages.value = [];
  draftFiles.value = [];
  sessionAttach.value = { pdfPages: 0, chars: 0 };
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
});

describe('файлы в поле ввода (этап 8 roadmap 0.2)', () => {
  it('file.picked → чип: значок типа, имя, размер, ~токены; у pdf без страниц «≈?»; +файлы у контекста', async () => {
    const host = mount();
    handleHostMessage({ type: 'file.picked', items: [TXT, PDF] });
    await flush();
    const chips = host.querySelectorAll('.att .im.file');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.querySelector('.ic')?.textContent).toBe('TXT');
    expect(chips[0]!.querySelector('b')?.textContent).toBe('notes.txt');
    expect(chips[0]!.querySelector('small')?.textContent).toBe('4 КБ · ~1k');
    expect(chips[0]!.getAttribute('data-tip')).toBe('docs/notes.txt');
    expect(chips[1]!.querySelector('.ic')?.textContent).toBe('PDF');
    expect(chips[1]!.querySelector('small')?.textContent).toBe('6 Б · ≈?');
    expect(host.querySelector('.ctx .cn .plus')?.textContent).toBe('+1k+? файлы');
    expect(host.querySelector('.ctx .hint')?.textContent).toBe(
      'перетащить с ⇧ — файл из проводника VS Code',
    );
  });

  it('отказ хоста — красная плашка с причиной; ✕ убирает; повтор того же файла не дублирует', async () => {
    const host = mount();
    handleHostMessage({
      type: 'file.picked',
      items: [
        { name: 'app.bin', problem: 'binary' },
        { name: 'src', problem: 'folder' },
      ],
    });
    addFiles([TXT, TXT]);
    await flush();
    const errs = host.querySelectorAll('.att .im.file.err');
    expect([...errs].map((e) => e.querySelector('small')?.textContent)).toEqual([
      'двоичный файл не берём',
      'папки не берём',
    ]);
    expect(errs[1]!.querySelector('.ph')?.textContent).toBe('/');
    expect(draftFiles.value.filter((d) => d.file)).toHaveLength(1);
    (errs[0]!.querySelector('.x') as HTMLElement).click();
    await flush();
    expect(host.querySelectorAll('.att .im.file.err')).toHaveLength(1);
  });

  it('лимиты сообщения: 11-й файл и сверх 20 МБ вместе — плашки', () => {
    addFiles(
      Array.from({ length: 11 }, (_, i) => ({ ...TXT, path: `f${i}.txt`, name: `f${i}.txt` })),
    );
    expect(draftFiles.value.at(-1)?.problem).toBe('count');
    draftFiles.value = [];
    addFiles([{ ...PDF, data: 'A'.repeat(MAX_MESSAGE_ATTACH_CHARS) }, { ...TXT }]);
    expect(draftFiles.value.map((d) => d.problem)).toEqual([undefined, 'total']);
  });

  it('лимиты API на сессию: pdf сверх 100 страниц с историей, тело запроса сверх 24 МБ, окно модели — плашки', () => {
    sessionAttach.value = { pdfPages: 70, chars: 0 };
    addFiles([
      { ...PDF, pages: 40 },
      { ...PDF, path: '/abs/b.pdf', name: 'b.pdf', pages: 30 },
    ]);
    expect(draftFiles.value.map((d) => d.problem)).toEqual(['sessionPages', undefined]);
    // pdf в одном поле тоже копятся: 70 + 30 + 1 > 100
    addFiles([{ ...PDF, path: '/abs/c.pdf', name: 'c.pdf', pages: 1 }]);
    expect(draftFiles.value.at(-1)?.problem).toBe('sessionPages');

    draftFiles.value = [];
    sessionAttach.value = { pdfPages: 0, chars: 23 * 1024 * 1024 };
    addFiles([{ ...TXT, data: 'x'.repeat(2 * 1024 * 1024), size: 100 }]);
    expect(draftFiles.value.at(-1)?.problem).toBe('session');

    // окно по умолчанию 200k, занято 160k: вложениям 70 % от 40k = 28k токенов ≈ 112k символов
    draftFiles.value = [];
    sessionAttach.value = { pdfPages: 0, chars: 0 };
    hudState.value = { ...initialHud(), context: { used: 160_000, max: 200_000 } };
    addFiles([
      { ...TXT, data: 'x'.repeat(60_000), size: 60_000 },
      { ...TXT, path: 'b.txt', name: 'b.txt', data: 'y'.repeat(60_000), size: 60_000 },
    ]);
    expect(draftFiles.value.map((d) => d.problem)).toEqual([undefined, 'context']);
  });

  it('session.attach от хоста обновляет счёт, session.reset и отправка — сбрасывают/копят его', () => {
    handleHostMessage({ type: 'session.attach', pdfPages: 12, chars: 345 });
    expect(sessionAttach.value).toEqual({ pdfPages: 12, chars: 345 });
    addFiles([{ ...PDF, pages: 5, data: 'AAAA' }]);
    expect(sendMessage('вот')).toBe(true);
    // до снимка хоста уже учтено: 12 + 5 страниц, 345 + 4 символа
    expect(sessionAttach.value).toEqual({ pdfPages: 17, chars: 349 });
    handleHostMessage({ type: 'session.reset' });
    expect(sessionAttach.value).toEqual({ pdfPages: 0, chars: 0 });
  });

  it('Enter: текст и файлы одним send; строка «в очереди» с чипами; поле очищено', async () => {
    const host = mount();
    addFiles([TXT, PDF, { name: 'x.zip', problem: 'binary' }]);
    await flush();
    const ed = typeText(host, 'что в файлах?');
    await flush();
    enter(ed);
    await flush();
    const send = posted.find((m) => m.type === 'send')!;
    expect(send).toMatchObject({
      text: 'что в файлах?',
      files: [
        { kind: 'text', path: 'docs/notes.txt', size: 4000 },
        { kind: 'pdf', path: '/abs/spec.pdf', data: 'JVBERi0x', size: 6 },
      ],
    });
    expect(send['images']).toBeUndefined();
    expect(draftFiles.value).toEqual([]);
    const row = chat.value.rows.at(-1) as Extract<FeedRow, { kind: 'user' }>;
    expect(row).toMatchObject({
      kind: 'user',
      queued: true,
      files: [{ path: 'docs/notes.txt' }, { path: '/abs/spec.pdf' }],
    });
  });

  it('только файл без текста — уходит; `/команда` файлы не забирает', async () => {
    const host = mount();
    addFiles([TXT]);
    await flush();
    const ed = typeText(host, '/review');
    await flush();
    enter(ed);
    await flush();
    expect(posted.find((m) => m.type === 'send')?.['files']).toBeUndefined();
    expect(draftFiles.value).toHaveLength(1);
    posted.length = 0;
    typeText(host, '');
    await flush();
    enter(ed);
    await flush();
    expect(posted.find((m) => m.type === 'send')).toMatchObject({
      text: '',
      files: [{ path: 'docs/notes.txt' }],
    });
  });

  it('drop из проводника VS Code: подсветка по типу uri-list, uri уходят хосту (все — из vnd.code.uri-list)', async () => {
    const host = mount();
    const dt = uriTransfer({
      'text/uri-list': 'file:///p/a.ts',
      'application/vnd.code.uri-list': 'file:///p/a.ts\r\nfile:///p/docs\r\n',
    });
    drag(host, 'dragenter', dt);
    await flush();
    expect(host.querySelector('footer.compose')!.classList.contains('drop')).toBe(true);
    expect(drag(host, 'drop', dt).defaultPrevented).toBe(true);
    await flush();
    expect(host.querySelector('footer.compose')!.classList.contains('drop')).toBe(false);
    expect(posted.at(-1)).toEqual({
      type: 'attach.uris',
      uris: ['file:///p/a.ts', 'file:///p/docs'],
    });
    // ответ хоста: картинка — миниатюрой, файл — чипом
    handleHostMessage({
      type: 'file.picked',
      items: [
        { ...TXT, name: 'a.ts', path: 'a.ts' },
        { name: 'docs', problem: 'folder' },
      ],
    });
    await flush();
    expect(host.querySelectorAll('.att .im.file')).toHaveLength(2);
  });

  it('drop не из VS Code: картинка — миниатюрой, прочие файлы — плашкой «через «+»», хосту ничего', async () => {
    const host = mount();
    const dt = uriTransfer({}, [
      new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }),
      new File([new Uint8Array([1])], 'report.pdf', { type: 'application/pdf' }),
    ]);
    expect(drag(host, 'drop', dt).defaultPrevented).toBe(true);
    await flush();
    expect(posted.filter((m) => m.type === 'attach.uris')).toHaveLength(0);
    expect(draftImages.value).toHaveLength(1);
    expect(host.querySelector('.att .im.file.err small')?.textContent).toBe(
      'не картинка — через «+»',
    );
  });

  it('transferUris: комментарии и ссылки браузера отбрасываются; без vnd — text/uri-list', () => {
    expect(
      transferUris(uriTransfer({ 'text/uri-list': '# c\nhttps://x.y/z\nfile:///a/b.txt\n' })),
    ).toEqual(['file:///a/b.txt']);
    expect(transferUris(uriTransfer({ 'text/uri-list': 'https://x.y/z' }))).toEqual([]);
    expect(transferUris(null)).toEqual([]);
  });
});

describe('чипы файлов в ленте', () => {
  it('реплика с файлами: значок, имя, размер; клик — file.open с путём и данными; содержимое не выводится', () => {
    let s = queueUser(initialState(), 'Глянь', undefined, [
      { kind: 'text', path: 'docs/notes.txt', size: 4000, data: 'СЕКРЕТНОЕ СОДЕРЖИМОЕ' },
    ]);
    s = applyEvent(
      s,
      {
        type: 'turn.start',
        prompt: 'И это',
        files: [{ kind: 'pdf', path: '/abs/spec.pdf', size: 2_500_000 }],
        at: 1,
      },
      1,
    );
    const host = document.createElement('div');
    document.body.append(host);
    render(
      h(Log, {
        rows: s.rows,
        cwd: '/p',
        now: 2,
        showThinking: true,
        mode: 'manual',
        onDiff: () => {},
        onPreview: () => {},
        onOpenUrl: () => {},
        onOpenFile: openFile,
      }),
      host,
    );
    expect(host.textContent).not.toContain('СЕКРЕТНОЕ');
    const chips = host.querySelectorAll<HTMLElement>('.log .u .att .fl');
    expect(chips).toHaveLength(2);
    expect([...chips].map((c) => c.textContent)).toEqual(['TXTnotes.txt4 КБ', 'PDFspec.pdf2.4 МБ']);
    expect(chips[1]!.getAttribute('data-tip')).toContain('копии в истории нет');
    chips[0]!.click();
    chips[1]!.click();
    expect(posted).toEqual([
      { type: 'file.open', kind: 'text', path: 'docs/notes.txt', data: 'СЕКРЕТНОЕ СОДЕРЖИМОЕ' },
      { type: 'file.open', kind: 'pdf', path: '/abs/spec.pdf' },
    ]);
  });

  it('turn.start своей строки «в очереди» не заменяет её файлы с данными файлами события без данных', () => {
    let s = queueUser(initialState(), 'Глянь', undefined, [
      { kind: 'text', path: 'a.txt', size: 3, data: 'abc' },
    ]);
    s = applyEvent(
      s,
      {
        type: 'turn.start',
        prompt: 'Глянь',
        files: [{ kind: 'text', path: 'a.txt', size: 3 }],
        at: 1,
      },
      1,
    );
    const row = s.rows.find((r) => r.kind === 'user') as Extract<FeedRow, { kind: 'user' }>;
    expect(row.queued).toBe(false);
    expect(row.files).toEqual([{ kind: 'text', path: 'a.txt', size: 3, data: 'abc' }]);
  });
});
