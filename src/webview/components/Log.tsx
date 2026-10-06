import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Seg } from '../fixtures/chat';
import type { FeedRow } from '../chatState';
import { onCodeCopyClick, renderMarkdown, withCursor } from '../markdown';
import { ui, uiLang } from '../strings';
import type { FileRef, ImageRef } from '../../agent/types';
import { imageTokens } from '../../shared/images';
import { fileBadge, fileName, formatBytes } from '../../shared/files';
import {
  artifactStatus,
  compactTokens,
  editStats,
  formatDuration,
  matchCount,
  toolLinks,
  toolView,
} from '../toolView';
import { FailCardView, PermissionCard, RefusalCardView, PlanCardView, QuestionCardView, ToolOutput } from './Cards';
import { agentGroupView, feedItems, type FeedItem } from '../agentsView';
import { feedTurns, foldSummary, stepRows, type FoldSummary, type Turn } from '../turnView';
import { initialHud, type HudState } from '../hudState';
import { AgentGroup } from './AgentGroup';

type Row<K extends FeedRow['kind']> = Extract<FeedRow, { kind: K }>;

export function Segs({ s }: { s: Seg[] }) {
  return (
    <>
      {s.map((x) => (typeof x === 'string' ? x : 'b' in x ? <b>{x.b}</b> : <code>{x.code}</code>))}
    </>
  );
}

/** Текст пользователя: `код` в обратных кавычках — как `<code>` в прототипе, переводы строк сохраняются. */
function UserText({
  text,
  images,
  files,
  onOpenImage,
  onOpenFile,
}: {
  text: string;
  images?: ImageRef[] | undefined;
  files?: FileRef[] | undefined;
  onOpenImage?: ((i: ImageRef) => void) | undefined;
  onOpenFile?: ((f: FileRef) => void) | undefined;
}) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <span>
      {parts.map((p) =>
        p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code>{p.slice(1, -1)}</code> : p,
      )}
      {images?.length ? <UserImages images={images} onOpen={onOpenImage} /> : null}
      {files?.length ? <UserFiles files={files} onOpen={onOpenFile} /> : null}
    </span>
  );
}

/**
 * Чипы файлов в реплике пользователя (этап 8 roadmap 0.2): значок типа, имя, размер. Содержимое в
 * ленту не выводится; клик открывает файл во вкладке редактора.
 */
function UserFiles({
  files,
  onOpen,
}: {
  files: FileRef[];
  onOpen?: ((f: FileRef) => void) | undefined;
}) {
  return (
    <span class="att files">
      {files.map((f, n) => {
        const outside = f.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(f.path);
        return (
          <button
            key={n}
            type="button"
            class="fl"
            data-tip={`${f.path}\n${outside && !f.data ? ui.log.fileNoCopy : ui.log.openFile}`}
            onClick={() => onOpen?.(f)}
          >
            <span class="ic">{fileBadge(f)}</span>
            <b>{fileName(f.path)}</b>
            {f.size !== undefined && <small>{formatBytes(f.size, uiLang)}</small>}
          </button>
        );
      })}
    </span>
  );
}

/** Миниатюры в реплике пользователя (этап 4 roadmap 0.2); без данных — плашка «скриншот». */
function UserImages({
  images,
  onOpen,
}: {
  images: ImageRef[];
  onOpen?: ((i: ImageRef) => void) | undefined;
}) {
  return (
    <span class="att">
      {images.map((i, n) => {
        const caption = [
          i.name ?? `${ui.log.screenshot} ${n + 1}`,
          ...(i.width && i.height
            ? [`${i.width}×${i.height}`, `~${compactTokens(imageTokens(i.width, i.height))}`]
            : []),
        ].join(' · ');
        return (
          <figure key={n}>
            {i.data && i.mediaType ? (
              <img
                class="mock"
                src={`data:${i.mediaType};base64,${i.data}`}
                alt={caption}
                data-tip={ui.log.openImage}
                role="button"
                tabIndex={0}
                onClick={() => onOpen?.(i)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen?.(i);
                  }
                }}
              />
            ) : (
              <span class="mock ph" data-tip={ui.log.noImageData}>
                {ui.log.screenshot}
              </span>
            )}
            <figcaption>{caption}</figcaption>
          </figure>
        );
      })}
    </span>
  );
}

interface Right {
  text?: string;
  add?: string;
  del?: string;
  err?: string;
  diff?: boolean;
  preview?: string;
  url?: string;
}

function ToolRight({
  r,
  onDiff,
  onPreview,
  onOpenUrl,
}: {
  r: Right;
  onDiff?: () => void;
  onPreview?: (path: string) => void;
  onOpenUrl?: (url: string) => void;
}) {
  // ссылки справа: «diff · превью · открыть» — каждая с разделителем ' · ' перед собой
  const link = (label: string, run: () => void) => (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        // в красной строке клик по ссылке не раскрывает вывод
        e.stopPropagation();
        run();
      }}
    >
      {label}
    </a>
  );
  let before = !!(r.add || r.del || r.text);
  const sep = () => {
    const out = before ? ' · ' : '';
    before = true;
    return out;
  };
  return (
    <span class="r">
      {r.err && <span class="del">{r.err}</span>}
      {r.err && r.text && ' · '}
      {r.add && <span class="add">{r.add}</span>}
      {r.add && ' '}
      {r.del && <span class="del">{r.del}</span>}
      {r.del && ' '}
      {(r.add || r.del) && r.text && '· '}
      {r.text}
      {r.diff && sep()}
      {r.diff && link(ui.log.diff, () => onDiff?.())}
      {r.preview !== undefined && sep()}
      {r.preview !== undefined && link(ui.log.preview, () => onPreview?.(r.preview as string))}
      {r.url !== undefined && sep()}
      {r.url !== undefined && link(ui.log.open, () => onOpenUrl?.(r.url as string))}
    </span>
  );
}

export function toolRight(t: Row<'tool'>, now: number): Right {
  if (t.state === 'run') {
    const ms = t.elapsedMs ?? Math.max(0, now - t.startedAt);
    return { text: formatDuration(ms) };
  }
  if (t.state === 'stopped') return { text: ui.log.toolStopped };
  const dur = t.durationMs !== undefined ? formatDuration(t.durationMs) : undefined;
  if (t.state === 'err') return { err: ui.log.toolError, ...(dur ? { text: dur } : {}) };
  const links = toolLinks(t.name, t.input, t.result, t.state);
  const stats = editStats(t.name, t.input, t.result);
  if (stats) {
    return {
      ...(stats.add ? { add: `+${stats.add}` } : {}),
      ...(stats.del ? { del: `−${stats.del}` } : {}),
      ...(dur ? { text: dur } : {}),
      diff: true,
      ...links,
    };
  }
  const status = t.name === 'Artifact' ? artifactStatus(t.result) : undefined;
  const n = matchCount(t.name, t.result);
  return {
    text: [status, n !== undefined ? String(n) : undefined, dur].filter(Boolean).join(' · '),
    ...links,
  };
}

export function Tool({
  t,
  cwd,
  now,
  onDiff,
  onPreview,
  onOpenUrl,
}: {
  t: Row<'tool'>;
  cwd: string;
  now: number;
  onDiff: (toolUseId: string) => void;
  onPreview: (path: string) => void;
  onOpenUrl: (url: string) => void;
}) {
  const v = toolView(t.name, t.input, cwd);
  const running = t.state === 'run';
  const failed = t.state === 'err';
  // красный результат раскрывается: вывод инструмента как его увидела модель
  const expandable = failed && !!t.content;
  const [open, setOpen] = useState(false);
  const cls = ['e', v.run && 'run', v.edit && 'ed', running && 'now', failed && 'fail'].filter(Boolean).join(' ');
  const toggle = () => expandable && setOpen(!open);
  return (
    <>
      <div
        class={cls}
        {...(expandable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              title: ui.fail.toolToggle,
              style: { cursor: 'pointer' },
              onClick: toggle,
              onKeyDown: (e: KeyboardEvent) => {
                // Enter на ссылке «diff» внутри строки — её, не раскрытие
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              },
            }
          : {})}
      >
        <span class="p">
          {running ? <span class="spin" /> : expandable ? open ? '▾' : '▸' : '▸'}
        </span>
        <span class="op">{v.op}</span>
        <span class="what">
          {v.dimAfter ? (
            <>
              {v.what} {v.dim && <span class="dim">{v.dim}</span>}
            </>
          ) : (
            <>
              {v.dim && <span class="dim">{v.dim}</span>}
              {v.what}
            </>
          )}
        </span>
        <ToolRight
          r={toolRight(t, now)}
          onDiff={() => onDiff(t.toolUseId)}
          onPreview={onPreview}
          onOpenUrl={onOpenUrl}
        />
      </div>
      {open && t.content && <ToolOutput content={t.content} />}
    </>
  );
}

function Think({ t, now }: { t: Row<'think'>; now: number }) {
  const [open, setOpen] = useState(false);
  const running = t.endedAt === undefined;
  const flat = t.text.replace(/\s+/g, ' ').trim();
  return (
    <>
      <div
        class={running ? 'e think now' : 'e think'}
        role="button"
        data-tip={ui.log.thinkToggle}
        style={{ cursor: t.text ? 'pointer' : undefined }}
        onClick={() => t.text && setOpen(!open)}
      >
        <span class="p">{running ? <span class="spin" /> : open ? '▾' : '▸'}</span>
        <span class="op">think</span>
        <span class="what">{flat || ui.log.thinking}</span>
        <span class="r">{formatDuration((t.endedAt ?? now) - t.startedAt)}</span>
      </div>
      {open && <div class="txt think-full">{t.text}</div>}
    </>
  );
}

function Text({ r, last }: { r: Row<'text'>; last: boolean }) {
  // лента перерисовывается каждую секунду (таймеры) — markdown разбираем только при смене текста
  const html = useMemo(() => renderMarkdown(r.text), [r.text]);
  return (
    <div
      class="txt"
      onClick={onCodeCopyClick}
      dangerouslySetInnerHTML={{ __html: r.streaming && last ? withCursor(html) : html }}
    />
  );
}

export function Log({
  rows,
  cwd,
  now,
  showThinking,
  mode,
  activeId,
  onDiff,
  onPreview,
  onOpenUrl,
  onOpenImage,
  onOpenFile,
  hud,
  onStopAgent,
  onOpenAgent,
  working,
  turnStartedAt,
  children,
}: {
  rows: FeedRow[];
  cwd: string;
  now: number;
  showThinking: boolean;
  /** Подпись режима для тега карточки разрешения («режим manual»). */
  mode: string;
  /** Строка карточки, которой адресованы Enter/Esc (подсказки клавиш только на ней). */
  activeId?: number;
  onDiff: (toolUseId: string) => void;
  onPreview: (path: string) => void;
  onOpenUrl: (url: string) => void;
  /** Клик по миниатюре в реплике — картинка во вкладке редактора. */
  onOpenImage?: (i: ImageRef) => void;
  /** Клик по чипу файла в реплике (этап 8) — файл во вкладке редактора. */
  onOpenFile?: (f: FileRef) => void;
  /** Агенты (A6): вызовы `Agent`/`Task` рисуются группой со статусами из приборов. */
  hud?: HudState;
  onStopAgent?: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  /** Движок сейчас ведёт ход: последний ход без итога — идущий (`data-state="live"`). */
  working?: boolean;
  /** Начало идущего хода — для «идёт Ns» в шапке карточки. */
  turnStartedAt?: number | undefined;
  children?: preact.ComponentChildren;
}) {
  // развёрнутые вручную завершённые ходы (вид «свёрнуто»); не персистится. Привязаны к первой строке ленты:
  // другая сессия или пересев истории (id строк снова с 1) — новая лента, раскрытое сбрасывается
  const anchor = rows[0];
  const [fold, setFold] = useState<{ anchor?: FeedRow | undefined; ids: ReadonlySet<number> }>({
    ids: new Set(),
  });
  const unfolded = fold.anchor === anchor ? fold.ids : NO_IDS;
  const toggleFold = (id: number) =>
    setFold((cur) => {
      const next = new Set(cur.anchor === anchor ? cur.ids : NO_IDS);
      if (!next.delete(id)) next.add(id);
      return { anchor, ids: next };
    });
  // ходы — по всем строкам (id хода не зависит от показа рассуждений), скрытые рассуждения — при рендере
  const items = feedItems(rows);
  const visible = (its: FeedItem[]) => (showThinking ? its : its.filter((it) => it.kind !== 'think'));
  const last = rows[rows.length - 1];

  const renderItem = (it: FeedItem) => {
    switch (it.kind) {
      case 'agents':
        return (
          <AgentGroup
            key={it.id}
            g={agentGroupView(it.rows, hud ?? initialHud(), now, cwd)}
            onStop={(id) => onStopAgent?.(id)}
            onOpen={(id) => onOpenAgent?.(id)}
          />
        );
      case 'sys':
        return (
          <div class={it.tone ? `sys ${it.tone}` : 'sys'} key={it.id}>
            <span class="p">▸</span>
            <span>
              <Segs s={it.text} />
            </span>
            {it.at && <span class="at">{it.at}</span>}
          </div>
        );
      case 'user':
        return <UserRowView key={it.id} u={it} onOpenImage={onOpenImage} onOpenFile={onOpenFile} />;
      case 'think':
        return showThinking ? <Think key={it.id} t={it} now={now} /> : null;
      case 'tool':
        return (
          <Tool
            key={it.id}
            t={it}
            cwd={cwd}
            now={now}
            onDiff={onDiff}
            onPreview={onPreview}
            onOpenUrl={onOpenUrl}
          />
        );
      case 'text':
        return <Text key={it.id} r={it} last={it === last} />;
      case 'perm':
        return (
          <PermissionCard
            key={it.id}
            c={it}
            cwd={cwd}
            mode={mode}
            active={it.id === activeId}
            onDiff={onDiff}
          />
        );
      case 'question':
        return <QuestionCardView key={it.id} c={it} active={it.id === activeId} />;
      case 'plan':
        return <PlanCardView key={it.id} c={it} cwd={cwd} />;
      case 'fail':
        return <FailCardView key={it.id} c={it} />;
      case 'refusal':
        return <RefusalCardView key={it.id} c={it} />;
      case 'sum':
        return <SumView key={it.id} r={it} />;
    }
  };

  const blocks = feedTurns(items);
  const lastBlock = blocks[blocks.length - 1];
  const liveTurn = working && lastBlock?.kind === 'turn' && !lastBlock.sum ? lastBlock : undefined;

  return (
    <div class="log" role="log" aria-label={ui.log.aria}>
      {blocks.map((b) => {
        if (b.kind === 'loose') return renderItem(b.item);
        const live = b === liveTurn;
        // ход закрыт итогом, а фоновые агенты или инструмент ещё идут — не прятать (там же их «stop»)
        const open = live || unfolded.has(b.id) || stillRunning(b, hud, now, cwd);
        const summary = turnFold(b, showThinking, now);
        let foldDone = false;
        return (
          <section
            class="turn"
            key={b.id}
            data-state={live ? 'live' : 'done'}
            data-open={open ? 'true' : 'false'}
          >
            {b.user && (
              <UserRowView
                u={b.user}
                onOpenImage={onOpenImage}
                onOpenFile={onOpenFile}
                tm={b.sum ? [b.sum.cost, b.sum.time] : live ? [ui.log.turnLive(turnStartedAt ? formatDuration(now - turnStartedAt) : '').trim()] : []}
              />
            )}
            <div class="who">{ui.log.who}</div>
            {b.parts.map((p) => {
              if (p.kind === 'item') return renderItem(p.item);
              const its = visible(p.items);
              if (!its.length) return null;
              const first = !foldDone;
              foldDone = true;
              return (
                <Fragment key={`s${p.id}`}>
                  {first && summary && (
                    <FoldRow
                      f={summary}
                      open={open}
                      live={live}
                      onToggle={() => !live && toggleFold(b.id)}
                    />
                  )}
                  <div class="steps">{its.map(renderItem)}</div>
                </Fragment>
              );
            })}
            {b.sum && <SumView r={b.sum} />}
            {live && children}
          </section>
        );
      })}
      {!liveTurn && children}
    </div>
  );
}

const NO_IDS: ReadonlySet<number> = new Set();
// сводка закрытого хода не меняется — считается раз на строку итога (и режим показа рассуждений)
const foldCache = new WeakMap<object, { thinking: boolean; f: FoldSummary | undefined }>();

function turnFold(b: Turn, thinking: boolean, now: number): FoldSummary | undefined {
  const hit = b.sum && foldCache.get(b.sum);
  if (hit && hit.thinking === thinking) return hit.f;
  const steps = b.parts.flatMap((p) =>
    p.kind === 'steps' ? (thinking ? p.items : p.items.filter((it) => it.kind !== 'think')) : [],
  );
  const f = steps.length ? foldSummary(stepRows(steps), now) : undefined;
  if (b.sum) foldCache.set(b.sum, { thinking, f });
  return f;
}

/** В ходе ещё что-то идёт: инструмент в работе или живая группа агентов (фоновые после итога хода). */
function stillRunning(b: Turn, hud: HudState | undefined, now: number, cwd: string | undefined): boolean {
  return b.parts.some(
    (p) =>
      p.kind === 'steps' &&
      p.items.some((it) =>
        it.kind === 'tool'
          ? it.state === 'run'
          : it.kind === 'agents' && agentGroupView(it.rows, hud ?? initialHud(), now, cwd).live,
      ),
  );
}

function UserRowView({
  u,
  tm,
  onOpenImage,
  onOpenFile,
}: {
  u: Row<'user'>;
  /** Цена и время хода (вид «карточки»): `[cost?, time]` или `[«идёт Ns»]`. */
  tm?: (string | undefined)[];
  onOpenImage?: ((i: ImageRef) => void) | undefined;
  onOpenFile?: ((f: FileRef) => void) | undefined;
}) {
  const tmText = tm?.filter(Boolean).join(' · ');
  return (
    <div class="u">
      <span class="p">&gt;</span>
      <UserText
        text={u.text}
        images={u.images}
        files={u.files}
        onOpenImage={onOpenImage}
        onOpenFile={onOpenFile}
      />
      <span class="at">
        {u.via && !u.queued && (
          <span class="src">{u.via === 'phone' ? ui.remote.fromPhone : ui.remote.fromWeb} ·</span>
        )}
        {u.queued ? ui.log.queued : u.at}
      </span>
      {tm && <span class="tm">{tmText}</span>}
    </div>
  );
}

function SumView({ r }: { r: Row<'sum'> }) {
  return (
    <div class="sum">
      {r.parts.map((p) => (
        <span>{p}</span>
      ))}
      {r.cost && <b>{r.cost}</b>}
      <span class="t">{r.time}</span>
    </div>
  );
}

/** Строка «▸ N действий · мини-полоса · сводка · время» (видна только в виде «свёрнуто»). */
function FoldRow({
  f,
  open,
  live,
  onToggle,
}: {
  f: FoldSummary;
  open: boolean;
  live: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      class={open ? 'fold open' : 'fold'}
      aria-expanded={open}
      aria-disabled={live || undefined}
      data-tip={live ? undefined : ui.log.foldToggle}
      onClick={onToggle}
    >
      <span class="p">▸</span>
      <span class="n">{ui.log.actions(f.count)}</span>
      <span class="what">
        {live ? (
          ui.log.foldLive
        ) : (
          <>
            <span class="mstrip" aria-hidden="true">
              {f.strip.map((g) => (
                <i class={g.cls} style={{ flex: g.flex }} />
              ))}
            </span>
            {foldWords(f)}
          </>
        )}
      </span>
      <span class="r">{formatDuration(f.durationMs)}</span>
    </button>
  );
}

/** `think 12s · read ×2 · grep · edit +6 −2 · bash 12s`. */
function foldWords(f: FoldSummary) {
  const parts: preact.ComponentChildren[] = [];
  if (f.thinkMs > 0) parts.push(`think ${Math.round(f.thinkMs / 1000)}s`);
  for (const o of f.ops) {
    parts.push(
      <>
        {o.times > 1 ? `${o.op} ×${o.times}` : o.op}
        {o.add ? <> <span class="add">+{o.add}</span></> : null}
        {o.del ? <> <span class="del">−{o.del}</span></> : null}
        {o.result ? <> <span class={o.bad ? 'del' : 'pass'}>{o.result}</span></> : null}
      </>,
    );
  }
  return parts.map((p, i) => (
    <>
      {i > 0 && ' · '}
      {p}
    </>
  ));
}
