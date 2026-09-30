import { useMemo, useState } from 'preact/hooks';
import type { Seg } from '../fixtures/chat';
import type { FeedRow } from '../chatState';
import { onCodeCopyClick, renderMarkdown, withCursor } from '../markdown';
import { ui } from '../strings';
import { editStats, formatDuration, matchCount, toolView } from '../toolView';

type Row<K extends FeedRow['kind']> = Extract<FeedRow, { kind: K }>;

export function Segs({ s }: { s: Seg[] }) {
  return (
    <>
      {s.map((x) => (typeof x === 'string' ? x : 'b' in x ? <b>{x.b}</b> : <code>{x.code}</code>))}
    </>
  );
}

/** Текст пользователя: `код` в обратных кавычках — как `<code>` в прототипе, переводы строк сохраняются. */
function UserText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <span>
      {parts.map((p) =>
        p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code>{p.slice(1, -1)}</code> : p,
      )}
    </span>
  );
}

interface Right {
  text?: string;
  add?: string;
  del?: string;
  err?: string;
  diff?: boolean;
}

function ToolRight({ r, onDiff }: { r: Right; onDiff?: () => void }) {
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
      {r.diff && (r.add || r.del || r.text ? ' · ' : '')}
      {r.diff && (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onDiff?.();
          }}
        >
          {ui.log.diff}
        </a>
      )}
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
  const stats = editStats(t.name, t.input, t.result);
  if (stats) {
    return {
      ...(stats.add ? { add: `+${stats.add}` } : {}),
      ...(stats.del ? { del: `−${stats.del}` } : {}),
      ...(dur ? { text: dur } : {}),
      diff: true,
    };
  }
  const n = matchCount(t.name, t.result);
  return { text: [n !== undefined ? String(n) : undefined, dur].filter(Boolean).join(' · ') };
}

export function Tool({
  t,
  cwd,
  now,
  onDiff,
}: {
  t: Row<'tool'>;
  cwd: string;
  now: number;
  onDiff: (toolUseId: string) => void;
}) {
  const v = toolView(t.name, t.input, cwd);
  const running = t.state === 'run';
  const cls = ['e', v.run && 'run', running && 'now'].filter(Boolean).join(' ');
  return (
    <div class={cls}>
      <span class="p">{running ? <span class="spin" /> : '▸'}</span>
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
      <ToolRight r={toolRight(t, now)} onDiff={() => onDiff(t.toolUseId)} />
    </div>
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
  onDiff,
  children,
}: {
  rows: FeedRow[];
  cwd: string;
  now: number;
  showThinking: boolean;
  onDiff: (toolUseId: string) => void;
  children?: preact.ComponentChildren;
}) {
  return (
    <div class="log">
      {rows.map((it, i) => {
        switch (it.kind) {
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
                <UserText text={it.text} />
                <span class="at">{it.queued ? ui.log.queued : it.at}</span>
              </div>
            );
          case 'think':
            return showThinking ? <Think key={it.id} t={it} now={now} /> : null;
          case 'tool':
            return <Tool key={it.id} t={it} cwd={cwd} now={now} onDiff={onDiff} />;
          case 'text':
            return <Text key={it.id} r={it} last={i === rows.length - 1} />;
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
