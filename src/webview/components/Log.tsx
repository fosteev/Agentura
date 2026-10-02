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
import { FailCardView, PermissionCard, PlanCardView, QuestionCardView, ToolOutput } from './Cards';
import { agentGroupView, feedItems } from '../agentsView';
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
            title={`${f.path}\n${outside && !f.data ? ui.log.fileNoCopy : ui.log.openFile}`}
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
                title={ui.log.openImage}
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
              <span class="mock ph" title={ui.log.noImageData}>
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
  const cls = ['e', v.run && 'run', running && 'now', failed && 'fail'].filter(Boolean).join(' ');
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
        title={ui.log.thinkToggle}
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
  children?: preact.ComponentChildren;
}) {
  const items = feedItems(rows);
  const last = rows[rows.length - 1];
  return (
    <div class="log" role="log" aria-label={ui.log.aria}>
      {items.map((it) => {
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
            return (
              <div class="u" key={it.id}>
                <span class="p">&gt;</span>
                <UserText
                  text={it.text}
                  images={it.images}
                  files={it.files}
                  onOpenImage={onOpenImage}
                  onOpenFile={onOpenFile}
                />
                <span class="at">{it.queued ? ui.log.queued : it.at}</span>
              </div>
            );
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
          case 'sum':
            return (
              <div class="sum" key={it.id}>
                {it.parts.map((p) => (
                  <span>{p}</span>
                ))}
                {it.cost && <b>{it.cost}</b>}
                <span>{it.time}</span>
              </div>
            );
        }
      })}
      {children}
    </div>
  );
}
