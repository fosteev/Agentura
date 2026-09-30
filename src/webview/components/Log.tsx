import type { LogItem, Seg, ToolRow } from '../fixtures/chat';
import { ui } from '../strings';

function Segs({ s }: { s: Seg[] }) {
  return (
    <>
      {s.map((x) => (typeof x === 'string' ? x : 'b' in x ? <b>{x.b}</b> : <code>{x.code}</code>))}
    </>
  );
}

function ToolRight({ r }: { r: ToolRow['r'] }) {
  return (
    <span class="r">
      {r.add && <span class="add">{r.add}</span>}
      {r.add && ' '}
      {r.del && <span class="del">{r.del}</span>}
      {r.del && ' '}
      {r.pass && <span class="pass">{r.pass}</span>}
      {r.pass && r.text && ' · '}
      {r.text}
      {r.diff && (r.add || r.del ? ' · ' : '')}
      {r.diff && <a href="#">{ui.log.diff}</a>}
    </span>
  );
}

function Tool({ t }: { t: ToolRow }) {
  const cls = ['e', t.think && 'think', t.run && 'run', t.now && 'now'].filter(Boolean).join(' ');
  return (
    <div class={cls}>
      <span class="p">{t.now ? <span class="spin" /> : '▸'}</span>
      <span class="op">{t.op}</span>
      <span class="what">
        {t.op === 'grep' ? (
          <>
            {t.what} <span class="dim">{t.dim}</span>
          </>
        ) : (
          <>
            {t.dim && <span class="dim">{t.dim}</span>}
            {t.what}
          </>
        )}
      </span>
      <ToolRight r={t.r} />
    </div>
  );
}

export function Log({ items }: { items: LogItem[] }) {
  return (
    <div class="log">
      {items.map((it) => {
        switch (it.kind) {
          case 'sys':
            return (
              <div class="sys">
                <span class="p">▸</span>
                <span>
                  <Segs s={it.text} />
                </span>
                <span class="at">{it.at}</span>
              </div>
            );
          case 'user':
            return (
              <div class="u">
                <span class="p">&gt;</span>
                <span>
                  <Segs s={it.text} />
                </span>
                <span class="at">{it.at}</span>
              </div>
            );
          case 'tool':
            return <Tool t={it} />;
          case 'text':
            return (
              <div class="txt">
                {it.paragraphs.map((p, i) => (
                  <p>
                    <Segs s={p} />
                    {it.cursor && i === it.paragraphs.length - 1 && <span class="cursor" />}
                  </p>
                ))}
              </div>
            );
          case 'sum':
            return (
              <div class="sum">
                {it.parts.map((p) => (
                  <span>{p}</span>
                ))}
                <b>{it.cost}</b>
                <span>{it.time}</span>
              </div>
            );
          case 'live':
            return (
              <div class="live">
                <span class="spin" /> {it.label} <button class="stop">{ui.log.stop}</button>
              </div>
            );
        }
      })}
    </div>
  );
}
