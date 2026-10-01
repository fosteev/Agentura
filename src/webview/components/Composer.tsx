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
import {
  autoAttachments,
  autoFile,
  autoSelection,
  capabilities,
  chat,
  compact,
  dismiss,
  dismissed,
  editor,
  extra,
  fileHits,
  history,
  limitBlocked,
  meters,
  newSession,
  removeExtra,
  replyTarget,
  sendMessage,
  submitReply,
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
    if (!t || closed) return;
    setHistIdx(undefined);
    // ответ карточке (свой вариант, доработка плана) — не сообщение агенту; `/команда` — команда
    if (replyTarget.value && !t.startsWith('/') && submitReply(t)) {
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
    <footer class={closed || blocked ? 'compose off' : 'compose'}>
      <div class="blocks" aria-hidden="true">
        {hv.context.blocks.map((b) => (
          <i class={b.cls} style={b.style} />
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
                tabIndex={0}
                aria-label={ui.compose.removeChip}
                title={ui.compose.removeChip}
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
                title={ui.compose.removeChip}
                onClick={() => removeExtra(attachmentKey(a))}
                onKeyDown={(e: KeyboardEvent) => pressKey(e, () => removeExtra(attachmentKey(a)))}
              >
                ✕
              </span>
            </span>
          );
        })}
        <span class="cn" title={hv.context.title}>
          {ui.compose.context} <b class={hv.context.numCls}>{hv.context.now}</b> / {hv.context.max}{' '}
          ·{' '}
          {hv.context.compacting && (
            <>
              <span class="spin" aria-hidden="true" /> {ui.log.compacting} ·{' '}
            </>
          )}
          {hv.context.note && <>{hv.context.note} · </>}
          <button onClick={compact}>{ui.compose.compact}</button>
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
            data-placeholder={
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
      {blocked && (
        <div class="note" role="status">
          <b>{deferredNote(blocked, tick.value)}</b>
        </div>
      )}
      <div class="opts">
        <span class="pop" onKeyDown={menuKeys}>
          <button
            class="plus"
            title={ui.compose.plusTitle}
            aria-haspopup="menu"
            aria-expanded={menu === 'plus'}
            onClick={() => toggle('plus')}
          >
            {ui.compose.plus}
          </button>
          {menu === 'plus' && (
            <div class="menu up" role="menu">
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
        <span class="pop" onKeyDown={menuKeys}>
          <button
            class="mode"
            aria-haspopup="menu"
            aria-expanded={menu === 'mode'}
            onClick={() => toggle('mode')}
          >
            {ui.compose.mode} <b>{modeLabel}</b>
          </button>
          {menu === 'mode' && (
            <div class="menu up" role="menu">
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
        <span class="pop" onKeyDown={menuKeys}>
          <button
            class="agent"
            title={ui.compose.agentTitle}
            aria-haspopup="menu"
            aria-expanded={menu === 'agent'}
            onClick={() => toggle('agent')}
          >
            {ui.compose.agent} <b>claude</b>
          </button>
          {menu === 'agent' && (
            <div class="menu up" role="menu">
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
        <span class="pop" onKeyDown={menuKeys}>
          <button
            aria-haspopup="menu"
            aria-expanded={menu === 'model'}
            onClick={() => toggle('model')}
          >
            {ui.compose.model} <b>{s.model ? shortModel(s.model) : '—'}</b>
          </button>
          {menu === 'model' && (
            <div class="menu up" role="menu">
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
          <span class="m" title={hv.cache.title}>
            <span
              class="clock"
              style={{
                background: hv.cache.expired
                  ? 'var(--bg-input)'
                  : `conic-gradient(var(--info) ${Math.round(hv.cache.left * 100)}%, var(--bg-input) 0)`,
              }}
            />
            {ui.compose.cache} <b>{hv.cache.time}</b> · <b>{hv.cache.hit}</b>
          </span>
          <LimitMeterView
            label={ui.compose.fiveHour}
            meter={hv.limits.five}
            title={hv.limits.title}
          />
          {hv.limits.week && hv.limits.week.percent > 70 && (
            <LimitMeterView
              label={ui.compose.weekShort}
              meter={hv.limits.week}
              title={hv.limits.title}
            />
          )}
        </span>
        <button
          class="send"
          title={ui.compose.sendTitle}
          // ответ карточке (вопрос, план) к лимиту не относится: Enter его пропускает — и кнопка тоже
          disabled={closed || (!!blocked && !target)}
          onClick={submit}
        >
          {ui.compose.send}
        </button>
      </div>
    </footer>
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
      <span class="m" title={title}>
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
    <span class={`m lim ${meter.level}`} title={title}>
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
