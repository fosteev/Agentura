import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { EffortLevel, PermissionMode } from '../../agent/types';
import { attachmentKey, attachmentLabel, type Attachment } from '../../shared/prompt';
import { addSys } from '../chatState';
import {
  applyCompletion,
  buildSlashItems,
  detectTrigger,
  filterSlash,
  historyStep,
  type SlashItem,
} from '../composer';
import {
  autoAttachments,
  autoFile,
  autoSelection,
  capabilities,
  chat,
  compact,
  composerLayout,
  interrupt,
  dismiss,
  dismissed,
  editor,
  extra,
  fileHits,
  addImages,
  draftFiles,
  draftImages,
  history,
  imagesBusy,
  limitBlocked,
  meters,
  newSession,
  removeExtra,
  removeFile,
  removeImage,
  rejectFiles,
  replyTarget,
  sendMessage,
  submitReply,
  type DraftFile,
  setEffort,
  setMode,
  setModel,
  showStatus,
  showThinking,
  tick,
} from '../store';
import type { LimitMeter } from '../hudView';
import { deferredNote } from '../limitView';
import { menuKeys } from '../a11y';
import { ui, uiLang } from '../strings';
import { compactTokens, shortModel } from '../toolView';
import { imageTokens, imagesTokens } from '../../shared/images';
import { fileBadge, fileTokens, filesTokens, formatBytes } from '../../shared/files';
import {
  hasFiles,
  transferImages,
  transferOthers,
  transferUris,
  type DraftImage,
} from '../imageDraft';
import { send } from '../vscode';

type MenuName = 'mode' | 'model' | 'effort' | 'agent' | 'plus' | 'engine';

/** Запасной список, пока движок не прислал `supportedModels()` (сессия ещё поднимается). */
const FALLBACK_MODELS = [
  { value: 'opus', displayName: 'opus', description: ui.menus.modelDesc.opus },
  { value: 'sonnet', displayName: 'sonnet', description: ui.menus.modelDesc.sonnet },
  { value: 'haiku', displayName: 'haiku', description: ui.menus.modelDesc.haiku },
];

const MODE_ORDER: PermissionMode[] = ['default', 'acceptEdits', 'plan'];

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode))
    return (el.textContent ?? '').length;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.anchorNode!, sel.anchorOffset);
  return range.toString().length;
}

function placeCaret(el: HTMLElement, offset: number): void {
  const node = el.firstChild;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (node && node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, Math.min(offset, node.textContent?.length ?? 0));
  } else {
    range.setStart(el, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

interface Item {
  key: string;
  label: string;
  small?: string;
  hint?: string;
  insert: string;
}

function ItemButton({
  it,
  selected,
  onPick,
}: {
  it: { label: string; small?: string; hint?: string; dis?: boolean };
  selected?: boolean;
  onPick?: () => void;
}) {
  const cls = ['it', selected && 'sel', it.dis && 'dis'].filter(Boolean).join(' ');
  const ref = useRef<HTMLButtonElement>(null);
  // Arrow keys move the selection; keep it visible in a menu taller than its max-height.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <button
      ref={ref}
      class={cls}
      role="menuitem"
      aria-disabled={it.dis ? true : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={it.dis ? undefined : onPick}
    >
      <span>
        {it.label}
        {it.small && <small>{it.small}</small>}
      </span>
      <span class="hint">{it.hint ?? ''}</span>
    </button>
  );
}

/** Enter/пробел на «кнопке» из `span role=button`. */
function pressKey(e: KeyboardEvent, act: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    act();
  }
}

/** Миниатюра над полем: готовая (размер, ~токены), «уменьшаю…» или красная плашка ошибки. */
function DraftChip({ d }: { d: DraftImage }) {
  const remove = (
    <span
      class="x"
      role="button"
      tabIndex={0}
      aria-label={ui.compose.imageRemove}
      data-tip={ui.compose.imageRemove}
      onClick={() => removeImage(d.id)}
      onKeyDown={(e: KeyboardEvent) => pressKey(e, () => removeImage(d.id))}
    >
      ✕
    </span>
  );
  if (d.problem) {
    return (
      <span class="im err">
        <span class="ph">{d.problem === 'format' ? d.ext || '?' : '!'}</span>
        <b data-tip={d.name}>{d.name}</b>
        <small data-tip={ui.compose.imageProblemTitle[d.problem]}>
          {d.problem === 'format'
            ? ui.compose.imageProblem.format(d.ext ?? '')
            : ui.compose.imageProblem[d.problem]}
        </small>
        {remove}
      </span>
    );
  }
  if (d.busy || !d.image) {
    return (
      <span class="im busy">
        <span class="mock" />
        <b>{d.name}</b>
        <small>{ui.compose.imageBusy}</small>
        {remove}
      </span>
    );
  }
  const i = d.image;
  const size =
    i.width && i.height
      ? `${i.width}×${i.height} · ~${compactTokens(imageTokens(i.width, i.height))}`
      : '';
  return (
    <span class="im">
      <img class="mock" src={`data:${i.mediaType};base64,${i.data}`} alt="" />
      <b>{d.name}</b>
      <small
        data-tip={d.original ? ui.compose.imageScaled(d.original.width, d.original.height) : undefined}
      >
        {size}
      </small>
      {remove}
    </span>
  );
}

/** Чип файла над полем (этап 8 roadmap 0.2): значок типа, имя, размер, ~токены, ✕ или плашка ошибки. */
function FileChip({ d }: { d: DraftFile }) {
  const remove = (
    <span
      class="x"
      role="button"
      tabIndex={0}
      aria-label={ui.compose.imageRemove}
      data-tip={ui.compose.imageRemove}
      onClick={() => removeFile(d.id)}
      onKeyDown={(e: KeyboardEvent) => pressKey(e, () => removeFile(d.id))}
    >
      ✕
    </span>
  );
  if (d.problem || !d.file) {
    const problem = d.problem ?? 'read';
    const ext = /\.([a-z0-9]{1,5})$/i.exec(d.name)?.[1];
    return (
      <span class="im file err">
        <span class="ph">{problem === 'folder' ? '/' : ext ? ext.toUpperCase() : '!'}</span>
        <b data-tip={d.name}>{d.name}</b>
        <small data-tip={ui.compose.fileProblemTitle[problem]}>
          {ui.compose.fileProblem[problem]}
        </small>
        {remove}
      </span>
    );
  }
  const f = d.file;
  const tokens = fileTokens(f);
  return (
    <span class="im file" data-tip={f.path}>
      <span class="ic">{fileBadge(f)}</span>
      <b>{d.name}</b>
      <small>
        {formatBytes(f.size, uiLang)} ·{' '}
        {tokens !== undefined ? `~${compactTokens(tokens)}` : ui.compose.fileUnknownTokens}
      </small>
      {remove}
    </span>
  );
}

function Switch({ on }: { on: boolean }) {
  return <span class={on ? 'sw on' : 'sw'} />;
}

export function Composer() {
  const s = chat.value;
  const hv = meters.value;
  const edRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [menu, setMenu] = useState<MenuName | undefined>();
  const [histIdx, setHistIdx] = useState<number | undefined>();
  const closed = !!s.closed;
  const target = replyTarget.value;
  // лимит исчерпан: текст набирать можно (сообщение не теряется), отправка — после сброса
  const blocked = limitBlocked.value;

  // «Свой вариант» / «Доработать план» — фокус в поле ввода
  useEffect(() => {
    if (target) edRef.current?.focus();
  }, [target]);

  // каретка: selectionchange ловит и клавиши, и мышь
  useEffect(() => {
    const onSel = () => {
      const el = edRef.current;
      if (el && document.activeElement === el) setCaret(caretOffset(el));
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  // закрытие всплывающих меню кликом вне и по Esc
  useEffect(() => {
    if (!menu) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.pop')) setMenu(undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenu(undefined);
        edRef.current?.focus();
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  const trig = closed || hidden ? undefined : detectTrigger(text, caret);

  // «@»: запрос файлов у хоста при смене набранного
  const requestId = useRef(0);
  /** Запрос → набранное: хиты показываются, только если ответ на то, что набрано сейчас. */
  const queries = useRef(new Map<number, string>());
  useEffect(() => {
    if (trig?.kind !== 'at') return;
    requestId.current += 1;
    queries.current.set(requestId.current, trig.query);
    queries.current.delete(requestId.current - 50);
    send({ type: 'files.find', requestId: requestId.current, query: trig.query });
  }, [trig?.kind, trig?.kind === 'at' ? trig.query : '']);

  const slashItems: SlashItem[] =
    trig?.kind === 'slash'
      ? filterSlash(
          buildSlashItems(
            capabilities.value.commands,
            s.slashCommands,
            s.skills,
            Object.fromEntries(Object.entries(ui.commands).map(([k, v]) => [k, v[0]])),
          ),
          trig.query,
        )
      : [];

  let items: Item[] = [];
  if (trig?.kind === 'slash') {
    items = slashItems.map((i) => ({
      key: i.name,
      label: `/${i.name}`,
      small: i.description || undefined,
      hint: i.own ? ui.commands[i.name]?.[1] : i.group === 'skill' ? ui.menus.skillHint : '',
      insert: i.name,
    }));
  } else if (trig?.kind === 'at' && queries.current.get(fileHits.value.requestId) === trig.query) {
    // старые хиты (прошлое «@» или ответ ещё не пришёл) не показываются и не вставляются
    items = fileHits.value.items.map((h) => ({
      key: h.path,
      label: h.isDir ? `${h.name}/` : h.name,
      small: h.dir || undefined,
      hint: h.isDir ? ui.menus.folderHint : ui.menus.fileHint,
      insert: h.isDir ? `${h.path}/` : h.path,
    }));
  }
  const menuOpen = !!trig && items.length > 0;
  const selected = Math.min(sel, Math.max(items.length - 1, 0));

  function writeText(t: string, at = t.length) {
    const el = edRef.current;
    if (!el) return;
    el.textContent = t;
    el.focus();
    placeCaret(el, at);
    setText(t);
    setCaret(at);
  }

  function accept(i: number) {
    const it = items[i];
    if (!it || !trig) return;
    const r = applyCompletion(text, caret, trig, it.insert);
    writeText(r.text, r.caret);
    setSel(0);
  }

  function submit() {
    const t = text.trim();
    const withImages =
      draftImages.value.some((d) => d.image || d.busy) || draftFiles.value.some((d) => d.file);
    if ((!t && !withImages) || closed) return;
    // картинка ещё уменьшается — Enter подождёт (текст и картинки уйдут вместе)
    if (imagesBusy.value) return;
    setHistIdx(undefined);
    // ответ карточке (свой вариант, доработка плана) — не сообщение агенту; `/команда` — команда
    if (t && replyTarget.value && !t.startsWith('/') && submitReply(t)) {
      writeText('');
      return;
    }
    const cmd = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(t);
    // лимит: уходит к движку всё, кроме локальных команд
    if (blocked && !(cmd && ['clear', 'status', 'plan'].includes(cmd[1]!))) return;
    if (cmd) {
      const name = cmd[1]!;
      if (name === 'clear') {
        newSession();
        writeText('');
        return;
      }
      if (name === 'compact') {
        send({ type: 'compact', sessionId: s.sessionId });
        writeText('');
        return;
      }
      if (name === 'plan') {
        setMode('plan');
        chat.value = addSys(chat.value, [ui.sys.planOn]);
        writeText('');
        return;
      }
      if (name === 'status') {
        showStatus();
        writeText('');
        return;
      }
    }
    if (!sendMessage(t, !t.startsWith('/'))) return;
    writeText('');
  }

  function stepHistory(dir: -1 | 1) {
    const h = history.value;
    const next = historyStep(h.length, histIdx, dir);
    setHistIdx(next);
    writeText(next === undefined ? '' : (h[next] ?? ''));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((selected + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((selected - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setHidden(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const i = MODE_ORDER.indexOf(s.mode);
      setMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]!);
    } else if (e.key === 'ArrowUp' && (text === '' || histIdx !== undefined)) {
      e.preventDefault();
      stepHistory(-1);
    } else if (e.key === 'ArrowDown' && histIdx !== undefined) {
      e.preventDefault();
      stepHistory(1);
    } else if (e.key === 'Escape' && histIdx !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      setHistIdx(undefined);
      writeText('');
    } else if (e.key === 'Escape' && replyTarget.value) {
      // отмена ответа карточке: поле снова пишет агенту, карточка ждёт дальше
      e.preventDefault();
      e.stopPropagation();
      replyTarget.value = undefined;
    }
  }

  // ⌘V: картинки из буфера — в миниатюры, текст вставляется как обычно
  function onPaste(e: ClipboardEvent) {
    const found = transferImages(e.clipboardData);
    if (found.length === 0) return;
    e.preventDefault();
    void addImages(found);
  }

  // перетаскивание файла (в VS Code — с ⇧): подсветка поля и картинки в миниатюры
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  function onDragEnter(e: DragEvent) {
    if (closed || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dropDepth.current += 1;
    setDropping(true);
  }
  function onDragOver(e: DragEvent) {
    if (closed || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave() {
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropping(false);
  }
  function onDrop(e: DragEvent) {
    dropDepth.current = 0;
    setDropping(false);
    if (closed) return;
    // проводник и вкладки VS Code отдают uri, а не файлы: читает хост (этап 8)
    const uris = transferUris(e.dataTransfer);
    if (uris.length) {
      e.preventDefault();
      send({ type: 'attach.uris', uris });
      edRef.current?.focus();
      return;
    }
    const found = transferImages(e.dataTransfer);
    const others = transferOthers(e.dataTransfer);
    if (found.length === 0 && others.length === 0) return;
    e.preventDefault();
    if (found.length) void addImages(found);
    if (others.length) rejectFiles(others, 'foreign');
    edRef.current?.focus();
  }

  function onInput() {
    const el = edRef.current!;
    const t = el.textContent ?? '';
    setText(t);
    setCaret(caretOffset(el));
    setSel(0);
    setHidden(false);
    if (histIdx !== undefined && t !== history.value[histIdx]) setHistIdx(undefined);
  }

  // чипы: автоконтекст и добавленное вручную
  const auto = autoAttachments(
    editor.value,
    { file: autoFile.value, selection: autoSelection.value },
    dismissed.value,
  );
  const autoKeys = new Set(auto.map(attachmentKey));
  const manual = extra.value.filter((x) => !autoKeys.has(attachmentKey(x)));

  const models = capabilities.value.models.length ? capabilities.value.models : FALLBACK_MODELS;
  const cur = s.model ?? '';
  const curModel = models.find((m) => cur === m.value || cur.includes(m.value));
  const efforts = (() => {
    const levels = (curModel as { effortLevels?: readonly EffortLevel[] } | undefined)
      ?.effortLevels;
    return levels?.length ? [...levels] : [...ui.efforts];
  })();

  const toggle = (name: MenuName) => setMenu(menu === name ? undefined : name);

  const drafts = draftImages.value;
  const draftTokens = imagesTokens(drafts.flatMap((d) => (d.image ? [d.image] : [])));
  const fileDrafts = draftFiles.value;
  const fileEstimate = filesTokens(fileDrafts.flatMap((d) => (d.file ? [d.file] : [])));
  const withFiles = fileDrafts.some((d) => d.file);
  const footerCls = ['compose', (closed || blocked) && 'off', dropping && 'drop']
    .filter(Boolean)
    .join(' ');

  const working = s.status === 'working';
  const menuProps: MenuProps = {
    menu,
    toggle,
    close: () => setMenu(undefined),
  };
  const layout = composerLayout.value;
  // раскладки кладут поле в разные обёртки — смена раскладки перемонтирует его пустым; вернуть набранное
  const shownLayout = useRef(layout);
  useLayoutEffect(() => {
    if (shownLayout.current === layout) return;
    shownLayout.current = layout;
    const el = edRef.current;
    if (el && (el.textContent ?? '') !== text) {
      el.textContent = text;
      setCaret(text.length);
    }
  }, [layout]);
  const modelProps = { models, curModel };

  const promptEl = (
    <PromptField
      edRef={edRef}
      placeholder={
        closed
          ? ui.compose.closedPlaceholder
          : blocked
            ? ui.limit.placeholder
            : target
              ? ui.reply[target.kind]
              : s.status === 'waiting'
                ? ui.reply.waiting
                : ui.compose.placeholder
      }
      closed={closed}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      menu={menuOpen && trig ? { kind: trig.kind, items, slash: slashItems, selected, onPick: accept } : undefined}
    />
  );
  const sendCtl = (look: SendLook) => (
    <SendControl
      look={look}
      working={working}
      disabled={closed || (!!blocked && !target)}
      onSend={submit}
      onStop={() => {
        interrupt();
        // стоп размонтируется вместе с ходом — фокус обратно в поле, а не на body
        edRef.current?.focus();
      }}
    />
  );
  const rootProps = {
    class: footerCls,
    'data-layout': layout,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
  const chips = <AutoContext auto={auto} manual={manual} look="chip" />;

  if (layout === 'card') {
    return (
      <footer {...rootProps}>
        <div class="frame">
          <Drafts drafts={drafts} fileDrafts={fileDrafts} />
          <div class="chips">{chips}</div>
          {promptEl}
          <div class="row">
            <PlusMenu {...menuProps} look="circle" />
            <ModeMenu {...menuProps} look="pill" />
            <EngineMenu {...menuProps} {...modelProps} efforts={efforts} look="full" />
            <span class="sp" />
            <ContextRing hv={hv} />
            {sendCtl('round')}
          </div>
        </div>
        <div class="ctx under">
          <DraftHint drafts={drafts.length} files={fileDrafts.length} />
          <Note histIdx={histIdx} blocked={blocked} />
          <ContextCount
            hv={hv}
            draftTokens={draftTokens}
            fileEstimate={fileEstimate}
            withFiles={withFiles}
          />
          <Meters hv={hv} look="under" />
        </div>
      </footer>
    );
  }

  if (layout === 'gauges') {
    return (
      <footer {...rootProps}>
        <div class="ctx top">
          <div class="chips">
            <Drafts drafts={drafts} fileDrafts={fileDrafts} />
            {chips}
            <DraftHint drafts={drafts.length} files={fileDrafts.length} />
          </div>
          <span class="g">
            <ContextGauge hv={hv} />
            <Meters hv={hv} look="time" />
          </span>
        </div>
        {promptEl}
        <Note histIdx={histIdx} blocked={blocked} />
        <div class="sets">
          <PlusMenu {...menuProps} look="file" />
          <ModeMenu {...menuProps} />
          <AgentMenu {...menuProps} look="value" />
          <ModelMenu {...menuProps} {...modelProps} look="value" />
          <EffortMenu {...menuProps} efforts={efforts} />
          <span class="sp" />
          {sendCtl('long')}
        </div>
      </footer>
    );
  }

  if (layout === 'minimal') {
    const idle = text === '' && drafts.length === 0 && fileDrafts.length === 0;
    const noted = histIdx !== undefined || !!blocked || closed || !!target;
    return (
      <footer {...rootProps} style={`--p:${hv.context.percent};--c:${hv.context.color}`}>
        <Drafts drafts={drafts} fileDrafts={fileDrafts} />
        <div class="one">
          <ModeMenu {...menuProps} look="dollar" />
          <div class="chips">{chips}</div>
          {promptEl}
          {hv.context.zone !== 'ok' && <ContextRing hv={hv} />}
          <Meters hv={hv} look="alert" />
          <PlusMenu {...menuProps} look="circle" />
          <EngineMenu {...menuProps} {...modelProps} efforts={efforts} look="short" />
          {sendCtl('enter')}
        </div>
        <div class="sub">
          <DraftHint drafts={drafts.length} files={fileDrafts.length} />
          <Note histIdx={histIdx} blocked={blocked} />
          {idle && !noted && <span class="dim cheat">{ui.compose.cheatsheet}</span>}
        </div>
      </footer>
    );
  }

  return (
    <footer {...rootProps}>
      <ContextBlocks blocks={hv.context.blocks} />
      <Drafts drafts={drafts} fileDrafts={fileDrafts} />
      <div class="ctx">
        <DraftHint drafts={drafts.length} files={fileDrafts.length} />
        {chips}
        <ContextCount
          hv={hv}
          draftTokens={draftTokens}
          fileEstimate={fileEstimate}
          withFiles={withFiles}
        />
      </div>
      {promptEl}
      <Note histIdx={histIdx} blocked={blocked} />
      <div class="opts">
        <PlusMenu {...menuProps} />
        <ModeMenu {...menuProps} />
        <AgentMenu {...menuProps} />
        <ModelMenu {...menuProps} {...modelProps} />
        <EffortMenu {...menuProps} efforts={efforts} />
        <Meters hv={hv} />
        {sendCtl('classic')}
      </div>
    </footer>
  );
}

type Hv = typeof meters.value;

/**
 * Открытое меню одно на всё поле (`menu` в `Composer`); закрытие кликом вне и по Esc — эффект в `Composer`, он узнаёт
 * «внутри» по `.closest('.pop')`. Поэтому каждое меню-часть рисуется в своей обёртке `.pop` внутри `footer.compose`.
 */
interface MenuProps {
  menu: MenuName | undefined;
  toggle: (name: MenuName) => void;
  close: () => void;
}

/** Полоса блоков контекста (20 клеток) над полем. */
function ContextBlocks({ blocks }: { blocks: Hv['context']['blocks'] }) {
  return (
    <div class="blocks" aria-hidden="true">
      {blocks.map((b) => (
        <i class={b.cls} style={b.style} />
      ))}
    </div>
  );
}

/** Черновики: миниатюры картинок и плашки файлов. */
function Drafts({ drafts, fileDrafts }: { drafts: DraftImage[]; fileDrafts: DraftFile[] }) {
  if (drafts.length === 0 && fileDrafts.length === 0) return null;
  return (
    <div class="att">
      {drafts.map((d) => (
        <DraftChip key={d.id} d={d} />
      ))}
      {fileDrafts.map((d) => (
        <FileChip key={`f${d.id}`} d={d} />
      ))}
    </div>
  );
}

/** Подсказка про черновики (картинки / файлы) в строке контекста. */
function DraftHint({ drafts, files }: { drafts: number; files: number }) {
  if (drafts > 0) return <span class="dim hint">{ui.compose.imagesHint}</span>;
  if (files > 0) return <span class="dim hint">{ui.compose.filesHint}</span>;
  return null;
}

/** Автоконтекст (файл / выделение) и вручную добавленное. `look` — вид чипа; пока рисуется только `chip`. */
function AutoContext({
  auto,
  manual,
}: {
  auto: Attachment[];
  manual: Attachment[];
  look: 'chip' | 'ref' | 'plus';
}) {
  return (
    <>
      {auto.map((a) => {
        const l = attachmentLabel(a);
        return (
          <span class="auto">
            {a.kind === 'selection' ? ui.compose.autoSelection : ui.compose.autoFile}{' '}
            <b>{a.kind === 'selection' ? l.range.trim() : l.name}</b>
            <span
              class="x"
              role="button"
              tabIndex={0}
              aria-label={ui.compose.removeChip}
              data-tip={ui.compose.removeChip}
              onClick={() => dismiss(attachmentKey(a))}
              onKeyDown={(e: KeyboardEvent) => pressKey(e, () => dismiss(attachmentKey(a)))}
            >
              ✕
            </span>
          </span>
        );
      })}
      {manual.map((a: Attachment) => {
        const l = attachmentLabel(a);
        return (
          <span>
            <code>{l.name}</code>
            {l.range}
            <span
              class="x"
              role="button"
              tabIndex={0}
              aria-label={ui.compose.removeChip}
              data-tip={ui.compose.removeChip}
              onClick={() => removeExtra(attachmentKey(a))}
              onKeyDown={(e: KeyboardEvent) => pressKey(e, () => removeExtra(attachmentKey(a)))}
            >
              ✕
            </span>
          </span>
        );
      })}
    </>
  );
}

/** «контекст N / max · сжать». */
function ContextCount({
  hv,
  draftTokens,
  fileEstimate,
  withFiles,
}: {
  hv: Hv;
  draftTokens: number;
  fileEstimate: ReturnType<typeof filesTokens>;
  withFiles: boolean;
}) {
  return (
    <span class="cn" data-tip={hv.context.title}>
      {ui.compose.context} <b class={hv.context.numCls}>{hv.context.now}</b>{' '}
      {draftTokens > 0 && (
        <>
          <span class="plus" data-tip={ui.compose.imagesPlusTitle}>
            {ui.compose.imagesPlus(compactTokens(draftTokens))}
          </span>{' '}
        </>
      )}
      {withFiles && (
        <>
          <span class="plus" data-tip={ui.compose.filesPlusTitle}>
            {ui.compose.filesPlus(
              fileEstimate.tokens > 0
                ? `${compactTokens(fileEstimate.tokens)}${fileEstimate.unknown ? '+?' : ''}`
                : '?',
            )}
          </span>{' '}
        </>
      )}
      / {hv.context.max} ·{' '}
      {hv.context.compacting && (
        <>
          <span class="spin" aria-hidden="true" /> {ui.log.compacting} ·{' '}
        </>
      )}
      {hv.context.note && <>{hv.context.note} · </>}
      <button onClick={compact}>{ui.compose.compact}</button>
    </span>
  );
}

/** Поле ввода и меню `/` `@`; состояние и обработчики — в `Composer`, поле только рисует. */
function PromptField({
  edRef,
  placeholder,
  closed,
  onInput,
  onKeyDown,
  onPaste,
  menu,
}: {
  edRef: { current: HTMLDivElement | null };
  placeholder: string;
  closed: boolean;
  onInput: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  menu?: {
    kind: 'slash' | 'at';
    items: Item[];
    slash: SlashItem[];
    selected: number;
    onPick: (i: number) => void;
  };
}) {
  return (
    <div class="pop">
      <div class="prompt">
        <span class="p">$</span>
        <div
          ref={edRef}
          class="typed"
          contenteditable={closed ? 'false' : 'plaintext-only'}
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      {menu && (
        <div class="menu up">
          {menu.kind === 'slash' ? (
            <SlashMenu
              items={menu.items}
              slash={menu.slash}
              selected={menu.selected}
              onPick={menu.onPick}
            />
          ) : (
            <>
              <div class="hd">{ui.menus.files}</div>
              {menu.items.map((it, i) => (
                <ItemButton it={it} selected={i === menu.selected} onPick={() => menu.onPick(i)} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Заметки под полем: просмотр истории и «лимит исчерпан». */
function Note({
  histIdx,
  blocked,
}: {
  histIdx: number | undefined;
  blocked: ReturnType<typeof limitBlocked.peek>;
}) {
  return (
    <>
      {histIdx !== undefined && (
        <div class="note">
          {ui.compose.historyLabel}{' '}
          <b>{ui.compose.historyPos(histIdx + 1, history.value.length)}</b> {ui.compose.historyNote}
        </div>
      )}
      {blocked && (
        <div class="note" role="status">
          <b>{deferredNote(blocked, tick.value)}</b>
        </div>
      )}
    </>
  );
}

/** `look` — вид кнопки-триггера: `classic` — как в строке настроек, остальные — для раскладок. */
function PlusMenu({
  menu,
  toggle,
  close,
  look = 'classic',
}: MenuProps & { look?: 'classic' | 'circle' | 'file' }) {
  return (
    <span class="pop" onKeyDown={menuKeys}>
      <button
        class={look === 'circle' ? 'plus ib' : 'plus'}
        data-tip={ui.compose.plusTitle}
        aria-label={ui.compose.plusTitle}
        aria-haspopup="menu"
        aria-expanded={menu === 'plus'}
        onClick={() => toggle('plus')}
      >
        {look === 'file' ? ui.compose.plusFile : ui.compose.plus}
      </button>
      {menu === 'plus' && (
        <div class="menu up" role="menu">
          <div class="hd">{ui.menus.addContext}</div>
          <ItemButton
            it={{ label: ui.menus.pickFile, hint: ui.menus.pickFileHint }}
            onPick={() => {
              close();
              send({ type: 'attach.pick' });
            }}
          />
          <button class="it" onClick={() => (autoFile.value = !autoFile.value)}>
            <span>
              {ui.menus.openFile}
              <small>
                {editor.value.file?.name ?? '—'} ·{' '}
                {autoFile.value ? ui.menus.autoOn : ui.menus.autoOff}
              </small>
            </span>
            <Switch on={autoFile.value} />
          </button>
          <button class="it" onClick={() => (autoSelection.value = !autoSelection.value)}>
            <span>
              {ui.menus.selection}
              <small>
                {editor.value.selection
                  ? `${attachmentLabel({ kind: 'selection', path: editor.value.selection.path, startLine: editor.value.selection.startLine, endLine: editor.value.selection.endLine }).range.trim()} · `
                  : ''}
                {autoSelection.value ? ui.menus.autoOn : ui.menus.autoOff}
              </small>
            </span>
            <Switch on={autoSelection.value} />
          </button>
          <div class="sep" />
          <ItemButton
            it={{ label: ui.menus.image, small: ui.menus.imageSmall, hint: ui.menus.imageHint }}
            onPick={() => {
              close();
              send({ type: 'image.pick' });
            }}
          />
        </div>
      )}
    </span>
  );
}

function ModeMenu({
  menu,
  toggle,
  close,
  look = 'label',
}: MenuProps & { look?: 'label' | 'pill' | 'dollar' }) {
  const s = chat.value;
  const modeLabel = ui.modes[s.mode]?.[0] ?? s.mode;
  return (
    <span class="pop" onKeyDown={menuKeys}>
      {look === 'label' ? (
        <button
          class="mode"
          aria-haspopup="menu"
          aria-expanded={menu === 'mode'}
          onClick={() => toggle('mode')}
        >
          {ui.compose.mode} <b>{modeLabel}</b>
        </button>
      ) : (
        <button
          class={look === 'pill' ? 'pill mode' : 'dollar mode'}
          data-mode={s.mode}
          data-tip={`${ui.compose.mode}: ${modeLabel}`}
          aria-label={`${ui.compose.mode}: ${modeLabel}`}
          aria-haspopup="menu"
          aria-expanded={menu === 'mode'}
          onClick={() => toggle('mode')}
        >
          {look === 'pill' ? <b>{modeLabel}</b> : '$'}
        </button>
      )}
      {menu === 'mode' && (
        <div class="menu up" role="menu">
          {(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as PermissionMode[]).map((m) => {
            const [label, small, hint] = ui.modes[m]!;
            const off = m === 'bypassPermissions' && !s.allowBypass;
            return (
              <ItemButton
                it={{
                  label,
                  small: off ? ui.menus.bypassOff : small,
                  hint: m === 'default' ? '⇧⇥' : hint,
                  dis: off,
                }}
                selected={s.mode === m}
                onPick={() => {
                  close();
                  setMode(m);
                }}
              />
            );
          })}
        </div>
      )}
    </span>
  );
}

function AgentItems({ close }: { close: () => void }) {
  const s = chat.value;
  return (
    <>
      <div class="hd">{ui.compose.agentMenu}</div>
      <ItemButton
        it={{
          label: 'Claude',
          small: ui.compose.claudeVia(s.engineVersion),
          hint: ui.compose.agentReady,
        }}
        selected
        onPick={close}
      />
      <ItemButton
        it={{
          label: 'Codex',
          small: ui.compose.acpAdapter,
          hint: ui.compose.agentSoon,
          dis: true,
        }}
      />
      <ItemButton
        it={{
          label: 'Gemini',
          small: ui.compose.acpAdapter,
          hint: ui.compose.agentSoon,
          dis: true,
        }}
      />
    </>
  );
}

interface ModelProps {
  models: ReadonlyArray<{ value: string; displayName: string; description?: string }>;
  curModel: unknown;
}

function ModelItems({ close, models, curModel }: { close: () => void } & ModelProps) {
  return (
    <>
      <div class="hd">{ui.menus.model}</div>
      {models.map((m) => (
        <ItemButton
          it={{ label: m.displayName, small: m.description }}
          selected={m === curModel}
          onPick={() => {
            close();
            setModel(m.value);
          }}
        />
      ))}
    </>
  );
}

function EffortItems({
  close,
  efforts,
}: {
  close: () => void;
  efforts: EffortLevel[] | string[];
}) {
  const s = chat.value;
  return (
    <>
      <div class="hd">{ui.menus.effort}</div>
      {efforts.map((l) => (
        <ItemButton
          it={{ label: l }}
          selected={s.effort === l}
          onPick={() => {
            close();
            setEffort(l as EffortLevel);
          }}
        />
      ))}
      <div class="sep" />
      <button class="it" onClick={() => (showThinking.value = !showThinking.value)}>
        <span>
          {ui.menus.thinking}
          <small>{ui.menus.thinkingHint}</small>
        </span>
        <Switch on={showThinking.value} />
      </button>
    </>
  );
}

/** `label` — «агент claude» (строка настроек), `value` — только значение (раскладка `gauges`). */
type TriggerLook = 'label' | 'value';

function AgentMenu({ menu, toggle, close, look = 'label' }: MenuProps & { look?: TriggerLook }) {
  return (
    <span class="pop" onKeyDown={menuKeys}>
      <button
        class="agent"
        data-tip={ui.compose.agentTitle}
        aria-haspopup="menu"
        aria-expanded={menu === 'agent'}
        onClick={() => toggle('agent')}
      >
        {look === 'label' ? (
          <>
            {ui.compose.agent} <b>claude</b>
          </>
        ) : (
          'claude'
        )}
      </button>
      {menu === 'agent' && (
        <div class="menu up" role="menu">
          <AgentItems close={close} />
        </div>
      )}
    </span>
  );
}

function ModelMenu({
  menu,
  toggle,
  close,
  models,
  curModel,
  look = 'label',
}: MenuProps & ModelProps & { look?: TriggerLook }) {
  const s = chat.value;
  const name = s.model ? shortModel(s.model) : '—';
  return (
    <span class="pop" onKeyDown={menuKeys}>
      <button aria-haspopup="menu" aria-expanded={menu === 'model'} onClick={() => toggle('model')}>
        {look === 'label' ? (
          <>
            {ui.compose.model} <b>{name}</b>
          </>
        ) : (
          <b>{name}</b>
        )}
      </button>
      {menu === 'model' && (
        <div class="menu up" role="menu">
          <ModelItems close={close} models={models} curModel={curModel} />
        </div>
      )}
    </span>
  );
}

function EffortMenu({
  menu,
  toggle,
  close,
  efforts,
}: MenuProps & { efforts: EffortLevel[] | string[] }) {
  const s = chat.value;
  return (
    <span class="pop" onKeyDown={menuKeys}>
      <button
        aria-haspopup="menu"
        aria-expanded={menu === 'effort'}
        onClick={() => toggle('effort')}
      >
        {ui.compose.effort} <b>{s.effort ?? 'auto'}</b>
      </button>
      {menu === 'effort' && (
        <div class="menu up" role="menu">
          <EffortItems close={close} efforts={efforts} />
        </div>
      )}
    </span>
  );
}

/**
 * Одна кнопка вместо трёх: «agent · model · effort» (`full`) или «model · effort» (`short`); меню — три секции из тех же
 * списков пунктов, что у отдельных меню.
 */
function EngineMenu({
  menu,
  toggle,
  close,
  models,
  curModel,
  efforts,
  look,
}: MenuProps & ModelProps & { efforts: EffortLevel[] | string[]; look: 'full' | 'short' }) {
  const s = chat.value;
  const parts = [
    ...(look === 'full' ? ['claude'] : []),
    s.model ? shortModel(s.model) : '—',
    s.effort ?? 'auto',
  ];
  return (
    <span class="pop eng" onKeyDown={menuKeys}>
      <button
        class={look === 'full' ? 'pill engine' : 'engine'}
        data-tip={ui.compose.engineTitle}
        aria-label={`${ui.compose.engineTitle}: ${parts.join(' · ')}`}
        aria-haspopup="menu"
        aria-expanded={menu === 'engine'}
        onClick={() => toggle('engine')}
      >
        {parts.join(' · ')}
      </button>
      {menu === 'engine' && (
        <div class="menu up" role="menu">
          <AgentItems close={close} />
          <div class="sep" />
          <ModelItems close={close} models={models} curModel={curModel} />
          <div class="sep" />
          <EffortItems close={close} efforts={efforts} />
        </div>
      )}
    </span>
  );
}

/** Кольцо заполнения контекста (`used / fullAt`) и процент; цвет — по зоне. */
function ContextRing({ hv }: { hv: Hv }) {
  const c = hv.context;
  return (
    <span class="cr" data-tip={c.title}>
      <span class="ring" style={`--p:${c.percent};--c:${c.color}`} aria-hidden="true" />
      <span class="pc" style={`color:${c.color}`}>
        {c.percent}%
      </span>
    </span>
  );
}

/** Полоса заполнения шкалы контекста с засечками порогов. */
function ContextBar({ hv }: { hv: Hv }) {
  const c = hv.context;
  return (
    <span class="bar" style={`--p:${c.fill};--c:${c.color}`} aria-hidden="true">
      <i />
      {c.marks.map((m) => (
        <u style={`left:${m}%`} />
      ))}
    </span>
  );
}

/** «контекст [полоса] 131k/200k · сжать» — компактная замена `ContextCount`. */
function ContextGauge({ hv }: { hv: Hv }) {
  const c = hv.context;
  return (
    <span class="cn gauge" data-tip={c.title}>
      {ui.compose.context} <ContextBar hv={hv} /> <b class={c.numCls}>{c.short}</b>{' '}
      {c.compacting && (
        <>
          <span class="spin" aria-hidden="true" /> {ui.log.compacting}{' '}
        </>
      )}
      <button onClick={compact}>{ui.compose.compact}</button>
    </span>
  );
}

/**
 * Приборы: кэш, 5 часов, неделя (если >70 %). `time` — кэш одним временем (без попаданий), `under` — подстрочник
 * карточки (ячейки скрыты стилем), `alert` — только окна лимитов хуже нормы (>70 %), текстом.
 */
function Meters({
  hv,
  look = 'classic',
}: {
  hv: Hv;
  look?: 'classic' | 'time' | 'under' | 'alert';
}) {
  const weekShown = hv.limits.week && hv.limits.week.percent > 70;
  if (look === 'alert') {
    const five = hv.limits.five && hv.limits.five.percent > 70 ? hv.limits.five : undefined;
    const week = weekShown ? hv.limits.week : undefined;
    if (!five && !week) return null;
    return (
      <span class="meters alert">
        {five && <LimitText label={ui.compose.fiveHour} meter={five} title={hv.limits.title} />}
        {week && <LimitText label={ui.compose.weekShort} meter={week} title={hv.limits.title} />}
      </span>
    );
  }
  return (
    <span class={look === 'classic' ? 'meters' : `meters ${look}`}>
      <span class="m" data-tip={hv.cache.title}>
        <span
          class="clock"
          style={{
            background: hv.cache.expired
              ? 'var(--bg-input)'
              : `conic-gradient(var(--info) ${Math.round(hv.cache.left * 100)}%, var(--bg-input) 0)`,
          }}
        />
        {look === 'time' ? (
          <b>{hv.cache.time}</b>
        ) : (
          <>
            {ui.compose.cache} <b>{hv.cache.time}</b> · <b>{hv.cache.hit}</b>
          </>
        )}
      </span>
      <LimitMeterView label={ui.compose.fiveHour} meter={hv.limits.five} title={hv.limits.title} />
      {weekShown && (
        <LimitMeterView label={ui.compose.weekShort} meter={hv.limits.week} title={hv.limits.title} />
      )}
    </span>
  );
}

/** Окно лимита текстом «5ч 82%» (раскладка `minimal`). */
function LimitText({
  label,
  meter,
  title,
}: {
  label: string;
  meter: LimitMeter;
  title: string;
}) {
  return (
    <span class={`m lim ${meter.level}`} data-tip={title}>
      {label} <b class={meter.full ? 'pct full' : 'pct'}>{meter.percent}%</b>
    </span>
  );
}

/** Вид кнопки отправки: `classic` — «enter ↵», `round` — ↑ в круге, `long` — «отправить ↵», `enter` — «↵». */
type SendLook = 'classic' | 'round' | 'long' | 'enter';

/** Отправка; пока идёт ход — «↵ в очередь» и стоп (Esc делает то же). */
function SendControl({
  look,
  working,
  disabled,
  onSend,
  onStop,
}: {
  look: SendLook;
  working: boolean;
  disabled: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  if (working) {
    return (
      <>
        <span class="q">{ui.compose.queue}</span>
        <button
          class="stopb"
          data-tip={ui.compose.stopTitle}
          data-tip-key="Esc"
          aria-label={ui.compose.stopTitle}
          onClick={onStop}
        >
          <i aria-hidden="true" />
          {ui.compose.stopKey}
        </button>
      </>
    );
  }
  return (
    <button
      class={look === 'classic' ? 'send' : 'send go'}
      aria-label={look === 'round' || look === 'enter' ? ui.compose.sendTitle : undefined}
      data-tip={ui.compose.sendTitle}
      data-tip-key="Enter"
      // ответ карточке (вопрос, план) к лимиту не относится: Enter его пропускает — и кнопка тоже
      disabled={disabled}
      onClick={onSend}
    >
      {look === 'classic'
        ? ui.compose.send
        : look === 'round'
          ? '↑'
          : look === 'long'
            ? ui.compose.sendLong
            : '↵'}
    </button>
  );
}

function LimitMeterView({
  label,
  meter,
  title,
}: {
  label: string;
  meter: LimitMeter | undefined;
  title: string;
}) {
  if (!meter) {
    return (
      <span class="m" data-tip={title}>
        <span class="cells">
          {Array.from({ length: 10 }, () => (
            <i />
          ))}
        </span>
        {label} <b>—</b>
      </span>
    );
  }
  return (
    <span class={`m lim ${meter.level}`} data-tip={title}>
      <span class="cells">
        {Array.from({ length: 10 }, (_, i) => (
          <i class={i < meter.cells ? (meter.full ? 'on f' : 'on') : ''} />
        ))}
      </span>
      {label} <b class={meter.full ? 'pct full' : 'pct'}>{meter.percent}%</b>
    </span>
  );
}

function SlashMenu({
  items,
  slash,
  selected,
  onPick,
}: {
  items: Item[];
  slash: SlashItem[];
  selected: number;
  onPick: (i: number) => void;
}) {
  const firstSkill = slash.findIndex((i) => i.group === 'skill');
  return (
    <>
      <div class="hd">{firstSkill === 0 ? ui.menus.skills : ui.menus.commands}</div>
      {items.map((it, i) => (
        <>
          {i === firstSkill && firstSkill > 0 && (
            <>
              <div class="sep" />
              <div class="hd">{ui.menus.skills}</div>
            </>
          )}
          <ItemButton it={it} selected={i === selected} onPick={() => onPick(i)} />
        </>
      ))}
    </>
  );
}
