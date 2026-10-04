import { useEffect, useRef, useState } from 'preact/hooks';
import type { DetailRowView } from '../agentsView';
import type { AgentOpenView } from '../agentViews';
import { graphLayout } from '../agentsGraph/layout';
import type { GraphModel, GraphNodeView } from '../agentsGraph/model';
import { ui } from '../strings';

/**
 * Граф агентов (roadmap 11, вид Д): холст с основным и агентами выбранного хода, полоса ходов сверху,
 * детали выбранного справа. Разметка и классы — блок `.gmap` прототипа `agents-map.html#e`, стили —
 * `media/agents-graph.css`. Модель готовая (`agentsGraph/model.ts`), раскладка — `graphLayout`.
 */
export interface AgentsGraphProps {
  /** Нет — снимка от чата ещё не было. */
  model: GraphModel | undefined;
  /** Размер холста задан (превью в ⚙); нет — измеряется. */
  size?: { w: number; h: number };
  onTurn: (turnNo: number) => void;
  onSelect: (agentId: string) => void;
  onStop: (taskId: string) => void;
  onTranscript: (agentId: string, taskId: string) => void;
}

const g = () => ui.agents.graph;

/** Видимый размер области прокрутки холста (без `ResizeObserver` — запасной). */
function useSize(fixed?: { w: number; h: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(fixed ?? { w: 800, h: 560 });
  useEffect(() => {
    if (fixed || !ref.current || typeof ResizeObserver === 'undefined') return;
    const el = ref.current;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (w > 0 && h > 0) setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  return { ref, size: fixed ?? size };
}

function Mark({ n }: { n: GraphNodeView }) {
  if (n.status === 'busy') {
    return n.kind === 'task' ? (
      <span class="run">◐</span>
    ) : (
      <span class="st">
        <span class="spin" />
      </span>
    );
  }
  return <span class="st">{n.mark}</span>;
}

function press(fn: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      fn();
    },
  };
}

function CallRow({ r }: { r: DetailRowView }) {
  return (
    <div class={r.now ? 'c now' : 'c'}>
      <span class="at">{r.at}</span>
      <span class="op">{r.op}</span>
      <span>
        {r.dimAfter ? (
          <>
            {r.ev} {r.dim && <span class="faint">{r.dim}</span>}
          </>
        ) : (
          <>
            {r.dim && <span class="faint">{r.dim}</span>}
            {r.ev}
          </>
        )}
      </span>
      <span class="d">{r.d}</span>
    </div>
  );
}

function Detail({
  d,
  onStop,
  onTranscript,
}: {
  d: AgentOpenView | undefined;
  onStop: (taskId: string) => void;
  onTranscript: (agentId: string, taskId: string) => void;
}) {
  if (!d) {
    return (
      <div class="gd am" aria-label={g().detailAria}>
        <div class="lbl">{g().pick}</div>
      </div>
    );
  }
  const cls = d.status === 'busy' ? 'run' : d.status === 'err' ? 'err' : d.status === 'ok' ? 'ok' : '';
  return (
    <div class="gd am" aria-label={g().detailAria}>
      <div class="hd">
        <div class="t">
          {d.title} <span class="ty">· {d.type}</span>
        </div>
        <div class="m">
          <span class={cls}>{d.statusText}</span>
          {d.meta.map((m) =>
            m.label ? (
              <span>
                {m.label} <b>{m.value}</b>
              </span>
            ) : (
              <span>{m.value}</span>
            ),
          )}
        </div>
        <div class="ac">
          {d.transcript && (
            <button
              data-tip={ui.agents.detail.transcriptTitle}
              onClick={() => onTranscript(d.agentId, d.taskId)}
            >
              {ui.agents.view.transcript}
            </button>
          )}
          {d.stopTaskId && (
            <button class="stop" data-tip={ui.agents.stopTitle} onClick={() => onStop(d.stopTaskId!)}>
              {ui.agents.view.stop}
            </button>
          )}
        </div>
      </div>
      {d.prompt && (
        <>
          <div class="lbl" data-tip={ui.agents.view.estTip}>
            {d.promptLabel}
          </div>
          <div class="q">{d.prompt}</div>
        </>
      )}
      <div class="lbl">{d.callsLabel}</div>
      {d.rows.length === 0 && <div class="c">{ui.agents.detail.empty}</div>}
      {d.rows.map((r, i) => (
        <CallRow key={i} r={r} />
      ))}
      {d.summary ? (
        <>
          <div class="lbl" data-tip={d.status === 'err' ? undefined : ui.agents.view.estTip}>
            {d.summaryLabel}
          </div>
          <div class={d.status === 'err' ? 'q err' : 'q'}>{d.summary}</div>
        </>
      ) : (
        d.status === 'busy' && <div class="lbl">{g().summaryPending}</div>
      )}
    </div>
  );
}

export function AgentsGraph({ model, size, onTurn, onSelect, onStop, onTranscript }: AgentsGraphProps) {
  const { ref, size: box } = useSize(size);
  const lay = model ? graphLayout(model.layout, box.w, box.h) : undefined;
  const pos = new Map(lay?.nodes.map((n) => [n.id, n]));
  const edgeOf = new Map(lay?.edges.map((e) => [e.id, e]));
  const empty = !model || model.nodes.length === 0;
  return (
    <div class="gmap" aria-label={g().aria}>
      <div class="cv">
        <div class="bar">
          <span>{g().turn}</span>
          <span class="turns" role="group" aria-label={g().turnsAria}>
            {model?.turns.map((t) => (
              <button
                key={t.turnNo}
                class={t.live ? 'live' : undefined}
                aria-pressed={t.turnNo === model.turnNo}
                onClick={() => onTurn(t.turnNo)}
              >
                {t.label}
              </button>
            ))}
          </span>
          {model?.total && (
            <span class="r">
              {g().agentsTotal} <b>{model.total.tokens}</b> · {model.total.time}
            </span>
          )}
        </div>
        <div class="sc" ref={ref}>
          {empty ? (
            <div class="none">{model ? ui.agents.view.empty : g().waiting}</div>
          ) : (
            lay && (
              <div class="pl" style={{ width: `${lay.width}px`, height: `${lay.height}px` }}>
                <svg class="edges" aria-hidden="true" width={lay.width} height={lay.height}>
                  {model.nodes.map((n) => {
                    const e = edgeOf.get(n.id);
                    return e ? <path key={n.id} class={n.kind === 'task' ? 'bg' : n.cls} d={e.d} /> : null;
                  })}
                </svg>
                <div
                  class={model.main.working ? 'n main busy' : 'n main'}
                  style={{
                    left: `${lay.main.x}px`,
                    top: `${lay.main.y}px`,
                    width: `${lay.main.w}px`,
                  }}
                >
                  <div class="h">
                    <span class={model.main.working ? 'ok' : 'mute'}>{model.main.working ? '●' : '○'}</span>
                    <span>{ui.agents.main}</span>
                    <span class="r">{model.main.model}</span>
                  </div>
                  <div class="t">{model.main.state}</div>
                  <div class="s">{model.main.context}</div>
                  <div class="ctxb">
                    <i class={model.main.ctxCls || undefined} style={{ width: `${model.main.ctxPct}%` }} />
                  </div>
                  <div class="s">{model.main.returned}</div>
                </div>
                {model.nodes.map((n) => {
                  const e = edgeOf.get(n.id);
                  return n.kind === 'agent' && e && n.up ? (
                    <span
                      key={`l-${n.id}`}
                      class="lab"
                      style={{ left: `${e.label.x}px`, top: `${e.label.y}px` }}
                      data-tip={g().edgeTip}
                    >
                      <span class="up">{n.up}</span> · <span class={n.downCls}>{n.down}</span>
                    </span>
                  ) : null;
                })}
                {model.nodes.map((n) => {
                  const p = pos.get(n.id);
                  if (!p) return null;
                  const sel = n.id === model.selectedId;
                  const cls = ['n', n.cls, sel && 'sel'].filter(Boolean).join(' ');
                  const style = { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px` };
                  const body = (
                    <>
                      <div class="h">
                        <Mark n={n} />
                        <span>{n.head}</span>
                        <span class="r">
                          {n.tokens && (
                            <>
                              <b>{n.tokens}</b> ·{' '}
                            </>
                          )}
                          {n.time}
                          {n.kind === 'task' && n.stopTaskId && (
                            <button
                              class="x"
                              data-tip={ui.agents.stopTitle}
                              aria-label={ui.agents.stopTitle}
                              onClick={() => onStop(n.stopTaskId!)}
                            >
                              ■
                            </button>
                          )}
                        </span>
                      </div>
                      <div class="t">{n.title}</div>
                      <div class="s">{n.sub || ' '}</div>
                    </>
                  );
                  return n.kind === 'agent' ? (
                    <div
                      key={n.id}
                      class={cls}
                      style={style}
                      data-agent={n.id}
                      aria-pressed={sel}
                      {...press(() => onSelect(n.id))}
                    >
                      {body}
                    </div>
                  ) : (
                    <div key={n.id} class={cls} style={style} data-task={n.id}>
                      {body}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
        {!empty && (
          <div class="legend">
            <span>{g().legendUp}</span>
            <span>{g().legendDown}</span>
            <span>{g().legendBg}</span>
          </div>
        )}
      </div>
      <Detail d={model?.detail} onStop={onStop} onTranscript={onTranscript} />
    </div>
  );
}
