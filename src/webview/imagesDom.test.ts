// @vitest-environment jsdom
import { h, render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './components/Composer';
import { Log } from './components/Log';
import {
  addImages,
  capabilities,
  chat,
  draftImages,
  editor,
  extra,
  handleHostMessage,
  sessionAttach,
  history,
  hudState,
  limits,
} from './store';
import { initialHud } from './hudState';
import { applyEvent, initialState, queueUser, type FeedRow } from './chatState';
import type { ImageCodec } from './imageDraft';
import type { AgentEvent } from '../agent/types';
import * as vscode from './vscode';

const posted: { type: string; [k: string]: unknown }[] = [];

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  render(h(Composer, {}), host);
  return host;
}
const flush = () => new Promise((r) => setTimeout(r, 120));

/** Кодек без canvas: скриншот 3024×1928 уменьшается до 1568×1000. */
const codec: ImageCodec = {
  decode: async () => ({ width: 3024, height: 1928 }),
  encode: async (_m, _d, _w, _h, type) => ({ mediaType: type, data: 'U01BTEw=' }),
};

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

/** `DataTransfer` для jsdom: файлы и типы. */
function transfer(files: File[]): DataTransfer {
  return { files, types: ['Files'], items: [] } as unknown as DataTransfer;
}

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
  sessionAttach.value = { pdfPages: 0, chars: 0 };
  hudState.value = initialHud();
  limits.value = { windows: [], updatedAt: 0 };
});

describe('картинки в поле ввода (этап 4 roadmap 0.2)', () => {
  it('миниатюра: имя «скриншот N», размер, ~токены, исходный размер в подсказке; +токены у контекста', async () => {
    const host = mount();
    await addImages([{ name: 'image.png', mediaType: 'image/png', data: 'iVBOR' }], codec);
    await flush();
    const f = host.querySelector('footer.compose')!;
    expect([...f.children].map((c) => c.className)).toEqual([
      'blocks',
      'att',
      'ctx',
      'pop',
      'opts',
    ]);
    const im = f.querySelector('.att .im')!;
    expect(im.className).toBe('im');
    expect(im.querySelector('img.mock')?.getAttribute('src')).toBe(
      'data:image/png;base64,U01BTEw=',
    );
    expect(im.querySelector('b')?.textContent).toMatch(/^скриншот \d+$/);
    expect(im.querySelector('small')?.textContent).toBe('1568×1000 · ~2.1k');
    expect(im.querySelector('small')?.getAttribute('title')).toBe('уменьшен с 3024×1928');
    expect(f.querySelector('.ctx .cn .plus')?.textContent).toBe('+2.1k картинки');
    expect(f.querySelector('.ctx .hint')?.textContent).toBe(
      '⌘V — вставить картинку · перетащить с ⇧',
    );
  });

  it('картинки сообщения вместе больше 20 МБ — последняя красной плашкой', async () => {
    const host = mount();
    const small: ImageCodec = { ...codec, decode: async () => ({ width: 100, height: 100 }) };
    const data = 'A'.repeat(4.5 * 1024 * 1024);
    await addImages(
      Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.png`, mediaType: 'image/png', data })),
      small,
    );
    await flush();
    expect(draftImages.value.filter((d) => d.image)).toHaveLength(4);
    const err = host.querySelector('.att .im.err small');
    expect(err?.textContent).toBe('сообщение больше 20 МБ');
  });

  it('HEIC — красная плашка с форматом; ✕ убирает', async () => {
    const host = mount();
    await addImages(
      [{ name: 'IMG_2041.heic', mediaType: 'image/heic', blob: new Blob(['x']) }],
      codec,
    );
    await flush();
    const err = host.querySelector('.att .im.err')!;
    expect(err.querySelector('.ph')?.textContent).toBe('HEIC');
    expect(err.querySelector('b')?.textContent).toBe('IMG_2041');
    expect(err.querySelector('small')?.textContent).toBe('HEIC не берём');
    expect(err.querySelector('small')?.getAttribute('title')).toBe(
      'поддерживаются png, jpeg, gif, webp',
    );
    (err.querySelector('.x') as HTMLElement).click();
    await flush();
    expect(host.querySelector('.att')).toBeNull();
  });

  it('история сессии уже почти у лимита запроса (24 МБ): новая картинка — плашка «начните новую»', async () => {
    const host = mount();
    sessionAttach.value = { pdfPages: 0, chars: 24 * 1024 * 1024 - 2 };
    await addImages([{ name: 'image.png', mediaType: 'image/png', data: 'iVBOR' }], codec);
    await flush();
    expect(draftImages.value.map((d) => d.problem)).toEqual(['session']);
    expect(host.querySelector('.att .im.err small')?.textContent).toBe(
      'сессия: вложений больше 24 МБ — начните новую',
    );
  });

  it('Enter: текст и готовые картинки одним send; строка «в очереди» с миниатюрой; поле очищено', async () => {
    const host = mount();
    await addImages(
      [
        { name: 'image.png', mediaType: 'image/png', data: 'iVBOR' },
        { name: 'x.heic', mediaType: 'image/heic', data: 'x' },
      ],
      codec,
    );
    await flush();
    const ed = typeText(host, 'что на скриншоте?');
    await flush();
    enter(ed);
    await flush();
    const send = posted.find((m) => m.type === 'send')!;
    expect(send).toMatchObject({
      text: 'что на скриншоте?',
      images: [{ mediaType: 'image/png', data: 'U01BTEw=', width: 1568, height: 1000 }],
    });
    expect((send['images'] as unknown[]).length).toBe(1);
    expect(draftImages.value).toEqual([]);
    const row = chat.value.rows.at(-1) as Extract<FeedRow, { kind: 'user' }>;
    expect(row).toMatchObject({ kind: 'user', queued: true, images: [{ width: 1568 }] });
  });

  it('`/команда` картинки не забирает — они остаются в поле', async () => {
    const host = mount();
    await addImages([{ name: 'image.png', mediaType: 'image/png', data: 'iVBOR' }], codec);
    await flush();
    const ed = typeText(host, '/review сейчас');
    await flush();
    enter(ed);
    await flush();
    const send = posted.find((m) => m.type === 'send')!;
    expect(send['text']).toBe('/review сейчас');
    expect(send['images']).toBeUndefined();
    expect(draftImages.value).toHaveLength(1);
  });

  it('только картинка, без текста — тоже уходит; пока уменьшается — Enter ждёт', async () => {
    const host = mount();
    let release: () => void = () => {};
    const slow: ImageCodec = {
      ...codec,
      decode: () =>
        new Promise((r) => {
          release = () => r({ width: 100, height: 50 });
        }),
    };
    const pending = addImages([{ name: 'image.png', mediaType: 'image/png', data: 'iVBOR' }], slow);
    await flush();
    expect(host.querySelector('.att .im.busy small')?.textContent).toBe('уменьшаю…');
    const ed = host.querySelector<HTMLElement>('.typed')!;
    enter(ed);
    expect(posted.filter((m) => m.type === 'send')).toHaveLength(0);
    release();
    await pending;
    await flush();
    enter(ed);
    expect(posted.find((m) => m.type === 'send')).toMatchObject({
      text: '',
      images: [{ data: 'iVBOR', width: 100, height: 50 }],
    });
  });

  it('⌘V с картинкой: вставка перехвачена, плашка «уменьшаю…»; текст из буфера — как обычно', async () => {
    const host = mount();
    const ed = host.querySelector<HTMLElement>('.typed')!;
    const paste = (dt: DataTransfer) => {
      const e = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'clipboardData', { value: dt });
      ed.dispatchEvent(e);
      return e;
    };
    const text = paste({ files: [], items: [], types: ['text/plain'] } as unknown as DataTransfer);
    expect(text.defaultPrevented).toBe(false);
    const img = paste(
      transfer([new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })]),
    );
    expect(img.defaultPrevented).toBe(true);
    await flush();
    expect(host.querySelectorAll('.att .im')).toHaveLength(1);
  });

  it('перетаскивание файла: подсветка поля, drop добавляет картинку', async () => {
    const host = mount();
    const f = host.querySelector<HTMLElement>('footer.compose')!;
    const drag = (type: string, dt: DataTransfer) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      f.dispatchEvent(e);
      return e;
    };
    const dt = transfer([new File([new Uint8Array([1])], 'shot.webp', { type: 'image/webp' })]);
    drag('dragenter', dt);
    await flush();
    expect(f.classList.contains('drop')).toBe(true);
    expect(drag('drop', dt).defaultPrevented).toBe(true);
    await flush();
    expect(f.classList.contains('drop')).toBe(false);
    expect(host.querySelector('.att .im b')?.textContent).toBe('shot');
  });

  it('«+» → «Изображение или файл…» просит диалог у хоста; ответ хоста — в миниатюры', async () => {
    const host = mount();
    (host.querySelector('.opts .plus') as HTMLElement).click();
    await flush();
    const item = [...host.querySelectorAll<HTMLElement>('.menu .it')].find((b) =>
      b.textContent?.startsWith('Изображение или файл…'),
    )!;
    expect(item.classList.contains('dis')).toBe(false);
    expect(item.querySelector('.hint')?.textContent).toBe('⌘V');
    item.click();
    expect(posted.at(-1)).toEqual({ type: 'image.pick' });
    handleHostMessage({
      type: 'image.picked',
      items: [{ name: 'big.png', mediaType: 'image/png', problem: 'size' }],
    });
    await flush();
    expect(host.querySelector('.att .im.err small')?.textContent).toBe('больше 5 МБ');
  });
});

describe('миниатюры в ленте', () => {
  it('реплика с картинками: figure + подпись; без данных — плашка «скриншот»; клик открывает', async () => {
    let s = queueUser(initialState(), 'Это то же самое?', [
      { mediaType: 'image/png', data: 'AAAA', width: 1568, height: 1000, name: 'скриншот 1' },
    ]);
    s = applyEvent(
      s,
      { type: 'turn.start', prompt: 'И это', images: [{ mediaType: 'image/png' }], at: 1 },
      1,
    );
    const opened: unknown[] = [];
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
        onOpenImage: (i) => opened.push(i),
      }),
      host,
    );
    const figs = host.querySelectorAll('.log .u .att figure');
    expect(figs).toHaveLength(2);
    expect(figs[0]!.querySelector('figcaption')?.textContent).toBe(
      'скриншот 1 · 1568×1000 · ~2.1k',
    );
    expect(figs[1]!.querySelector('.mock.ph')?.textContent).toBe('скриншот');
    expect(figs[1]!.querySelector('figcaption')?.textContent).toBe('скриншот 1');
    (figs[0]!.querySelector('img.mock') as HTMLElement).click();
    expect(opened).toEqual([expect.objectContaining({ data: 'AAAA' })]);
  });

  it('итог хода: «картинки ≈…» отдельно — оценка, движок их не различает', () => {
    let s = applyEvent(
      initialState(),
      {
        type: 'turn.start',
        prompt: 'x',
        images: [
          { width: 1568, height: 1000 },
          { width: 1200, height: 764 },
        ],
        at: 1,
      },
      1,
    );
    const result: AgentEvent = {
      type: 'turn.result',
      ok: true,
      subtype: 'success',
      interrupted: false,
      durationMs: 19000,
      apiDurationMs: 0,
      numTurns: 1,
      usage: { input: 3520, output: 640, cacheRead: 402100, cacheWrite: 3900 },
      totalCostUsd: 0.06,
      costUsd: 0.06,
      permissionDenials: [],
    };
    s = applyEvent(s, result, 2);
    const sum = s.rows.find((r) => r.kind === 'sum') as Extract<FeedRow, { kind: 'sum' }>;
    expect(sum.parts).toEqual(['in 3 520', 'out 640', 'картинки ≈3.3k', 'cache r402 100 w3 900']);
    // следующий ход без картинок — без пометки
    s = applyEvent(s, { type: 'turn.start', prompt: 'y', at: 3 }, 3);
    s = applyEvent(s, result, 4);
    const last = s.rows.filter((r) => r.kind === 'sum').at(-1) as Extract<FeedRow, { kind: 'sum' }>;
    expect(last.parts.some((p) => p.startsWith('картинки'))).toBe(false);
  });
});
