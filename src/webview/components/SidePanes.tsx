import type { AgentDetailView, AgentMapView, MapRowView } from '../agentsView';
import type { AgentScope, ViewsPane } from '../agentViews';
import { AgentsCards, AgentsLanes, AgentsTree } from './AgentViews';
import type { ChangesScope, ChangesView } from '../changesView';
import { ui } from '../strings';
import { formatDuration } from '../toolView';

/** Вкладка «изменения»: охват, итог, файлы по папкам с номерами ходов, ниже — последние проверки. */
export function ChangesPane({
  view,
  hidden,
  labelledBy = 'tab-changes',
  onScope,
  onDiff,
}: {
  view: ChangesView;
  hidden?: boolean;
  /** id вкладки-подписи: шапка (`tab-changes`) или вкладка панели (`ptab-changes`). */
  labelledBy?: string;
  onScope: (scope: ChangesScope) => void;
  /** Открыть дифф правок с этими `toolUseId` (файл — его правки, «дифф всего» — все). */
  onDiff: (toolUseIds: string[]) => void;
}) {
  const c = ui.changes;
  return (
    <section
      class="tabpane cg"
      id="pane-changes"
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
    >
      <div class="scope" role="group" aria-label={c.scopeAria}>
        <button aria-pressed={view.scope === 'session'} onClick={() => onScope('session')}>
          {c.session}
        </button>
        <button aria-pressed={view.scope === 'turn'} onClick={() => onScope('turn')}>
          {c.turn(view.lastTurn)}
        </button>
      </div>
      {view.fileCount === 0 ? (
        <div class="empty">{view.scope === 'turn' ? c.emptyTurn : c.emptySession}</div>
      ) : (
        <>
          <div class="tot">
            <span>
              <b>{view.fileCount}</b> {c.files(view.fileCount)}
            </span>
            {(view.add > 0 || view.del > 0) && (
              <span class="mono">
                <span class="add">+{view.add}</span> <span class="del">−{view.del}</span>
              </span>
            )}
            <button class="lnk" data-tip={c.diffAllTitle} onClick={() => onDiff(view.ids)}>
              {c.diffAll}
            </button>
          </div>
          {view.dirs.map((d) => (
            <>
              <div class="dir">{d.dir || c.root}</div>
              {d.files.map((f) => (
                <div
                  class={f.live ? 'file live' : 'file'}
                  role="button"
                  tabIndex={0}
                  data-tip={c.fileTitle}
                  onClick={() => onDiff(f.ids)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onDiff(f.ids);
                    }
                  }}
                >
                  <span class="nm">{f.base}</span>
                  <span class="ch mono">
                    {f.isNew && <span class="new">{c.newFile}</span>}
                    {f.stats && (
                      <>
                        {' '}
                        {f.stats.add > 0 && <span class="add">+{f.stats.add}</span>}
                        {f.stats.add > 0 && f.stats.del > 0 && ' '}
                        {f.stats.del > 0 && <span class="del">−{f.stats.del}</span>}
                      </>
                    )}
                  </span>
                  <span class="tn">
                    {f.turns.map((n) => (
                      <i
                        class={f.live && n === view.lastTurn ? 'live' : undefined}
                        data-tip={c.turnTitle(n)}
                      >
                        {n}
                      </i>
                    ))}
                  </span>
                </div>
              ))}
            </>
          ))}
        </>
      )}
      {view.checks.length > 0 && (
        <>
          <h5>{c.checks}</h5>
          {view.checks.map((k) => (
            <div class="chk">
              {k.state === 'run' ? (
                <span class="spin" />
              ) : (
                <span class={k.state === 'ok' ? 'pass' : 'fail'}>
                  {k.state === 'ok' ? '✓' : '✗'}
                </span>
              )}
              <code data-tip={k.command}>{k.command}</code>
              <span class={k.state === 'run' ? 'r run' : 'r'}>
                {k.state === 'run' ? `${formatDuration(k.ms)}…` : formatDuration(k.ms)} · {k.turn}
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/** Что показывает вкладка «агенты»: список (А) со своей моделью или один из видов Б/В/Г. */
export type AgentsPaneModel =
  | { mode: 'list'; view: AgentMapView }
  | { mode: 'views'; view: ViewsPane }
  /** Вид Б/В/Г на скрытой вкладке: модель не строится. */
  | { mode: 'hidden' };

/**
 * Вкладка «агенты» (A6, roadmap 11): вид выбирает `agentura.agents.view` — список (слева агенты хода,
 * справа выбранный), дерево сессии, дорожки времени или карточки.
 */
export function AgentsPane({
  model,
  now,
  hidden,
  labelledBy = 'tab-agents',
  onSelect,
  onStop,
  onTranscript,
  onScope,
  onGraph,
}: {
  model: AgentsPaneModel;
  now: number;
  hidden?: boolean;
  labelledBy?: string;
  onSelect: (agentId: string) => void;
  onStop: (taskId: string) => void;
  onTranscript: (agentId: string, taskId: string) => void;
  /** Охват «ход / сессия» видов Б/В/Г. */
  onScope: (scope: AgentScope) => void;
  /** Открыть граф во вкладке редактора; нет — кнопки «↗ граф» нет (поверхности графа ещё нет). */
  onGraph?: () => void;
}) {
  const act = { onSelect, onStop, onTranscript };
  if (model.mode === 'hidden') {
    return (
      <section
        class="tabpane"
        id="pane-agents"
        role="tabpanel"
        aria-labelledby={labelledBy}
        hidden
      />
    );
  }
  if (model.mode === 'views') {
    const pane = model.view;
    const common = { pane, now, act, onScope, ...(onGraph ? { onGraph } : {}) };
    return (
      <section
        class="tabpane"
        id="pane-agents"
        role="tabpanel"
        aria-labelledby={labelledBy}
        hidden={hidden}
      >
        {pane.mode === 'tree' ? (
          <AgentsTree {...common} />
        ) : pane.mode === 'lanes' ? (
          <AgentsLanes {...common} />
        ) : (
          <AgentsCards {...common} />
        )}
      </section>
    );
  }
  const view = model.view;
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
              data-tip={ui.agents.stopTitle}
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
          <h4>
            {view.heading}
            {onGraph && (
              <button class="lnk" data-tip={ui.agents.view.graphTitle} onClick={onGraph}>
                {ui.agents.view.graph}
              </button>
            )}
          </h4>
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
              data-tip={ui.agents.detail.transcriptTitle}
              onClick={() => onTranscript(d.agentId, d.taskId)}
            >
              {ui.agents.detail.transcript}
            </button>
          )}
          {d.stopTaskId && (
            <button
              class="stop"
              data-tip={ui.agents.stopTitle}
              onClick={() => onStop(d.stopTaskId!)}
            >
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
