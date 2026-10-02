import type { AgentDetailView, AgentMapView, MapRowView } from '../agentsView';
import type { TimelineView } from '../hudView';
import { ui } from '../strings';
import { useStickToBottom } from '../useStickToBottom';

export function TurnPane({
  turns,
  hidden,
  labelledBy = 'tab-turn',
}: {
  turns: TimelineView[];
  hidden?: boolean;
  /** id вкладки-подписи: шапка (`tab-turn`) или вкладка панели (`ptab-turn`). */
  labelledBy?: string;
}) {
  // в широкой вёрстке панель скроллится сама (hud.css) и во время хода липнет к низу, как лента
  const { ref, onScroll } = useStickToBottom<HTMLElement>([turns]);
  return (
    <section
      ref={ref}
      onScroll={onScroll}
      class="tabpane"
      id="pane-turn"
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
    >
      {turns.length === 0 && (
        <>
          <h4>{ui.tabs.turn}</h4>
          <div class="tl">
            <div class="row">
              <span class="at" />
              <span class="ev" style={{ color: 'var(--fg-faint)' }}>
                {ui.agents.empty}
              </span>
            </div>
          </div>
        </>
      )}
      {turns.map((t) => (
        <>
          <h4>{t.heading}</h4>
          <div class="tl">
            <div class="strip" aria-hidden="true">
              {t.strip.map((s) => (
                <i class={s.cls} style={{ flex: s.flex }} />
              ))}
            </div>
            {t.rows.map((r) => (
              <div class={r.now ? 'row now' : 'row'}>
                <span class="at">{r.at}</span>
                <span
                  class="ev"
                  style={
                    r.tone
                      ? { color: r.tone === 'agent' ? 'var(--agent)' : 'var(--warn)' }
                      : r.mute
                        ? { color: 'var(--fg-mute)' }
                        : undefined
                  }
                >
                  {r.ev}
                  <span class="d">{r.d}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      ))}
    </section>
  );
}

/** Вкладка «агенты» (A6): слева дерево агентов хода, справа (в узкой — ниже) выбранный агент. */
export function AgentsPane({
  view,
  hidden,
  labelledBy = 'tab-agents',
  onSelect,
  onStop,
  onTranscript,
}: {
  view: AgentMapView;
  hidden?: boolean;
  labelledBy?: string;
  onSelect: (agentId: string) => void;
  onStop: (taskId: string) => void;
  onTranscript: (agentId: string, taskId: string) => void;
}) {
  const row = (a: MapRowView) => {
    const pick = a.agentId && a.cls.includes('sub') ? a.agentId : undefined;
    return (
      <div
        class={a.cls}
        key={a.agentId ?? 'main'}
        {...(pick
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-pressed': a.cls.includes('sel'),
              onClick: () => onSelect(pick),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                e.preventDefault();
                onSelect(pick);
              },
            }
          : {})}
      >
        <span class="st">{a.mark}</span>
        <span
          class="nm"
          style={a.depth > 1 ? { paddingLeft: `${(a.depth - 1) * 12}px` } : undefined}
        >
          {a.name}
          <small>{a.meta}</small>
        </span>
        <span class="tk">
          {a.tokens}
          {a.stopTaskId && (
            <button
              title={ui.agents.stopTitle}
              aria-label={ui.agents.stopTitle}
              onClick={(e) => {
                e.stopPropagation();
                onStop(a.stopTaskId!);
              }}
            >
              ■
            </button>
          )}
        </span>
      </div>
    );
  };
  const d = view.detail;
  return (
    <section
      class="tabpane"
      id="pane-agents"
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
    >
      <div class="amap">
        <div class="list">
          <h4>{view.heading}</h4>
          <div class="ag">
            {view.rows.map(row)}
            {view.tasks.length > 0 && <h5>{ui.agents.tasks}</h5>}
            {view.tasks.map(row)}
            {view.bar.length > 0 && (
              <>
                <h5>{ui.agents.bar}</h5>
                <div class="bar" aria-hidden="true">
                  {view.bar.map((b) => (
                    <i class={b.cls} style={{ flex: b.flex }} />
                  ))}
                </div>
              </>
            )}
            <div class="tot">
              {view.totals.map((t) => (
                <>
                  <span>{t.label}</span>
                  <b>{t.value}</b>
                </>
              ))}
            </div>
          </div>
        </div>
        {d && <AgentDetail d={d} onStop={onStop} onTranscript={onTranscript} />}
      </div>
    </section>
  );
}

function AgentDetail({
  d,
  onStop,
  onTranscript,
}: {
  d: AgentDetailView;
  onStop: (taskId: string) => void;
  onTranscript: (agentId: string, taskId: string) => void;
}) {
  const tone =
    d.status === 'busy'
      ? { class: 'live' }
      : d.status === 'ok'
        ? { style: { color: 'var(--ok)' } }
        : d.status === 'err'
          ? { style: { color: 'var(--full)' } }
          : {};
  return (
    <div class="det">
      <div class="hd">
        <span class="t">
          {d.title} <span class="ty">· {d.type}</span>
        </span>
        <span class="meta">
          <span {...tone}>{d.statusText}</span>
          {d.meta.map((m) =>
            m.label ? (
              <span>
                {m.label} <b>{m.value}</b>
              </span>
            ) : (
              <span>{m.value}</span>
            ),
          )}
        </span>
        <span class="acts">
          {d.transcript && (
            <button
              title={ui.agents.detail.transcriptTitle}
              onClick={() => onTranscript(d.agentId, d.taskId)}
            >
              {ui.agents.detail.transcript}
            </button>
          )}
          {d.stopTaskId && (
            <button class="stop" onClick={() => onStop(d.stopTaskId!)}>
              {ui.agents.detail.stop}
            </button>
          )}
        </span>
      </div>
      {d.prompt && (
        <>
          <h6>{ui.agents.detail.prompt}</h6>
          <div class="prm">{d.prompt}</div>
        </>
      )}
      {d.summary && (
        <>
          <h6>{d.summaryLabel}</h6>
          <div class="prm">{d.summary}</div>
        </>
      )}
      <h6>{d.timelineLabel}</h6>
      <div class="tl">
        {d.strip.length > 0 && (
          <div class="strip" aria-hidden="true">
            {d.strip.map((s) => (
              <i class={s.cls} style={{ flex: s.flex }} />
            ))}
          </div>
        )}
        {d.rows.length === 0 && (
          <div class="row">
            <span class="at" />
            <span class="op" />
            <span class="ev" style={{ color: 'var(--fg-mute)' }}>
              {ui.agents.detail.empty}
            </span>
            <span class="d" />
          </div>
        )}
        {d.rows.map((r) => (
          <div class={r.now ? 'row now' : 'row'}>
            <span class="at">{r.at}</span>
            <span class="op">{r.op}</span>
            <span class="ev" style={r.mute ? { color: 'var(--fg-mute)' } : undefined}>
              {r.dimAfter ? (
                <>
                  {r.ev} {r.dim && <span class="dim">{r.dim}</span>}
                </>
              ) : (
                <>
                  {r.dim && <span class="dim">{r.dim}</span>}
                  {r.ev}
                </>
              )}
            </span>
            <span class="d">{r.d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
