import { useEffect, useRef, useState } from 'preact/hooks';
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
import type { Hud as HudData } from '../fixtures/chat';
import {
  autoAttachments,
  autoFile,
  autoSelection,
  capabilities,
  chat,
  dismiss,
  dismissed,
  editor,
  extra,
  fileHits,
  history,
  newSession,
  removeExtra,
  sendMessage,
  setEffort,
  setMode,
  setModel,
  showThinking,
} from '../store';
import { ui } from '../strings';
import { shortModel } from '../toolView';
import { send } from '../vscode';

type MenuName = 'mode' | 'model' | 'effort' | 'agent' | 'plus';

/** Запасной список, пока движок не прислал `supportedModels()` (сессия ещё поднимается). */
const FALLBACK_MODELS = [
  { value: 'opus', displayName: 'opus', description: 'сложные задачи, планирование' },
  { value: 'sonnet', displayName: 'sonnet', description: 'быстрее и дешевле' },
  { value: 'haiku', displayName: 'haiku', description: 'мелкие правки' },
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
  return (
    <button
      class={cls}
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

function Switch({ on }: { on: boolean }) {
  return <span class={on ? 'sw on' : 'sw'} />;
}

export function Composer({ hud }: { hud: HudData }) {
  const s = chat.value;
  const edRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [menu, setMenu] = useState<MenuName | undefined>();
  const [histIdx, setHistIdx] = useState<number | undefined>();
  const closed = !!s.closed;

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
  useEffect(() => {
    if (trig?.kind !== 'at') return;
    requestId.current += 1;
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
  } else if (trig?.kind === 'at') {
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
    if (!t || closed) return;
    const cmd = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(t);
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
        const st = chat.value;
        chat.value = addSys(st, [
          ui.sys.status(
            st.model ? shortModel(st.model) : '—',
            ui.modes[st.mode]?.[0] ?? st.mode,
            st.cwd,
          ),
        ]);
        writeText('');
        return;
      }
    }
    if (!sendMessage(t, !t.startsWith('/'))) return;
    setHistIdx(undefined);
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
    }
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
  const modeLabel = ui.modes[s.mode]?.[0] ?? s.mode;

  return (
    <footer class={closed ? 'compose off' : 'compose'}>
      <div class="blocks" aria-hidden="true">
        {hud.blocks.map((c) => (
          <i class={c} />
        ))}
      </div>
      <div class="ctx">
        {auto.map((a) => {
          const l = attachmentLabel(a);
          return (
            <span class="auto">
              {a.kind === 'selection' ? ui.compose.autoSelection : ui.compose.autoFile}{' '}
              <b>{a.kind === 'selection' ? l.range.trim() : l.name}</b>
              <span
                class="x"
                role="button"
                title={ui.compose.removeChip}
                onClick={() => dismiss(attachmentKey(a))}
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
                title={ui.compose.removeChip}
                onClick={() => removeExtra(attachmentKey(a))}
              >
                ✕
              </span>
            </span>
          );
        })}
        <span class="cn" title={ui.compose.ctxTitle}>
          {ui.compose.context} <b class="warn">{hud.ctxNow}</b> / {hud.ctxMax} ·{' '}
          <button onClick={() => send({ type: 'compact', sessionId: s.sessionId })}>
            {ui.compose.compact}
          </button>
        </span>
      </div>
      <div class="pop">
        <div class="prompt">
          <span class="p">$</span>
          <div
            ref={edRef}
            class="typed"
            contenteditable={closed ? 'false' : 'plaintext-only'}
            role="textbox"
            aria-multiline="true"
            data-placeholder={closed ? ui.compose.closedPlaceholder : ui.compose.placeholder}
            onInput={onInput}
            onKeyDown={onKeyDown}
          />
        </div>
        {menuOpen && trig && (
          <div class="menu up">
            {trig.kind === 'slash' ? (
              <SlashMenu items={items} slash={slashItems} selected={selected} onPick={accept} />
            ) : (
              <>
                <div class="hd">{ui.menus.files}</div>
                {items.map((it, i) => (
                  <ItemButton it={it} selected={i === selected} onPick={() => accept(i)} />
                ))}
              </>
            )}
          </div>
        )}
      </div>
      {histIdx !== undefined && (
        <div class="note">
          {ui.compose.historyLabel}{' '}
          <b>{ui.compose.historyPos(histIdx + 1, history.value.length)}</b> {ui.compose.historyNote}
        </div>
      )}
      <div class="opts">
        <span class="pop">
          <button class="plus" title={ui.compose.plusTitle} onClick={() => toggle('plus')}>
            {ui.compose.plus}
          </button>
          {menu === 'plus' && (
            <div class="menu up">
              <div class="hd">{ui.menus.addContext}</div>
              <ItemButton
                it={{ label: ui.menus.pickFile, hint: ui.menus.pickFileHint }}
                onPick={() => {
                  setMenu(undefined);
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
              <ItemButton it={{ label: ui.menus.imageSoon, small: ui.menus.soon, dis: true }} />
            </div>
          )}
        </span>
        <span class="pop">
          <button class="mode" onClick={() => toggle('mode')}>
            {ui.compose.mode} <b>{modeLabel}</b>
          </button>
          {menu === 'mode' && (
            <div class="menu up">
              {(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as PermissionMode[]).map(
                (m) => {
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
                        setMenu(undefined);
                        setMode(m);
                      }}
                    />
                  );
                },
              )}
            </div>
          )}
        </span>
        <span class="pop">
          <button class="agent" title={ui.compose.agentTitle} onClick={() => toggle('agent')}>
            {ui.compose.agent} <b>{hud.agent}</b>
          </button>
          {menu === 'agent' && (
            <div class="menu up">
              <div class="hd">{ui.compose.agentMenu}</div>
              <ItemButton
                it={{
                  label: 'Claude',
                  small: ui.compose.claudeVia(s.engineVersion),
                  hint: ui.compose.agentReady,
                }}
                selected
                onPick={() => setMenu(undefined)}
              />
              <ItemButton
                it={{
                  label: 'Codex',
                  small: 'адаптер по форме ACP',
                  hint: ui.compose.agentSoon,
                  dis: true,
                }}
              />
              <ItemButton
                it={{
                  label: 'Gemini',
                  small: 'адаптер по форме ACP',
                  hint: ui.compose.agentSoon,
                  dis: true,
                }}
              />
            </div>
          )}
        </span>
        <span class="pop">
          <button onClick={() => toggle('model')}>
            {ui.compose.model} <b>{s.model ? shortModel(s.model) : '—'}</b>
          </button>
          {menu === 'model' && (
            <div class="menu up">
              <div class="hd">{ui.menus.model}</div>
              {models.map((m) => (
                <ItemButton
                  it={{ label: m.displayName, small: m.description }}
                  selected={m === curModel}
                  onPick={() => {
                    setMenu(undefined);
                    setModel(m.value);
                  }}
                />
              ))}
            </div>
          )}
        </span>
        <span class="pop">
          <button onClick={() => toggle('effort')}>
            {ui.compose.effort} <b>{s.effort ?? 'auto'}</b>
          </button>
          {menu === 'effort' && (
            <div class="menu up">
              <div class="hd">{ui.menus.effort}</div>
              {efforts.map((l) => (
                <ItemButton
                  it={{ label: l }}
                  selected={s.effort === l}
                  onPick={() => {
                    setMenu(undefined);
                    setEffort(l);
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
            </div>
          )}
        </span>
        <span class="meters">
          <span class="m">
            <span class="clock" />
            {ui.compose.cache} <b>{hud.cache.time}</b> · <b>{hud.cache.hit}</b>
          </span>
          <span class="m" title={ui.compose.fiveHourTitle(hud.h5.reset)}>
            <span class="cells">
              {Array.from({ length: 10 }, (_, i) => (
                <i class={i < hud.h5.cells ? 'on' : ''} />
              ))}
            </span>
            {ui.compose.fiveHour} <b>{hud.h5.percent}%</b>
          </span>
        </span>
        <button class="send" title={ui.compose.sendTitle} disabled={closed} onClick={submit}>
          {ui.compose.send}
        </button>
      </div>
    </footer>
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
