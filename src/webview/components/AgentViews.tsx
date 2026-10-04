import { useState } from 'preact/hooks';
import type { DetailRowView } from '../agentsView';
import { clock } from '../chatState';
import type {
  AgentLine,
  AgentOpenView,
  AgentStatus,
  CardView,
  LaneView,
  TaskLine,
  TurnGroup,
  ViewsPane,
} from '../agentViews';
import { ui } from '../strings';
import { compactTokens, formatDuration } from '../toolView';

/**
 * Виды вкладки «агенты» (roadmap 11): дерево, дорожки, карточки. Разметка и классы — по
 * `prototype/screens/agents-map.html` (варианты Б, В, Г), стили — `media/agents-map.css`. Компоненты
 * получают готовую модель (`agentViews.ts`) и ничего не считают сами.
 */
export interface AgentViewActions {
  onSelect: (agentId: string) => void;
  onStop: (taskId: string) => void;
  onTranscript: (agentId: string, taskId: string) => void;
}

const v = () => ui.agents.view;

/** Клик и Enter/Space по не-кнопочному элементу. */
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

function Mark({ status, mark }: { status: AgentStatus; mark: string }) {
  if (status === 'busy') {
    return (
      <span class="run">
        <span class="spin" />
      </span>
    );
  }
  return <span class={status === 'ok' ? 'ok' : status === 'err' ? 'err' : 'mute'}>{mark}</span>;
}

/** Шапка вкладки: охват «ход / сессия», справа — итог вида и кнопка графа (если есть куда открывать). */
function Top({
  pane,
  right,
  onScope,
  onGraph,
}: {
  pane: ViewsPane;
  right: preact.ComponentChildren;
  onScope: (scope: 'turn' | 'session') => void;
  onGraph?: () => void;
}) {
  const turnNo = pane.groups[0]?.turnNo;
  return (
    <div class="top">
      <span class="seg" role="group" aria-label={v().scopeAria}>
        <button aria-pressed={pane.scope === 'turn'} onClick={() => onScope('turn')}>
          {turnNo !== undefined ? v().scopeTurn(turnNo) : v().scopeTurnNone}
        </button>
        <button aria-pressed={pane.scope === 'session'} onClick={() => onScope('session')}>
          {v().scopeSession}
        </button>
      </span>
      <span class="r">{right}</span>
      {onGraph && (
        <button class="btn" data-tip={v().graphTitle} onClick={onGraph}>
          {v().graph}
        </button>
      )}
    </div>
  );
}

function Marks({ g }: { g: TurnGroup }) {
  const c = g.counts;
  return (
    <>
      {c.ok > 0 && <span class="ok">{'✓'.repeat(c.ok)}</span>}
      {c.err > 0 && <span class="err">{'✕'.repeat(c.err)}</span>}
      {c.stop > 0 && <span class="mute">{'■'.repeat(c.stop)}</span>}
      {c.run > 0 && <span class="run">{'◐'.repeat(c.run)}</span>}
    </>
  );
}

/** Строка хода: раскрытый — «идёт 1:18», свёрнутый — `ход 12 · 14:30 · Explore ×2 ✓✓`. */
function TurnHead({
  g,
  open,
  now,
  onToggle,
}: {
  g: TurnGroup;
  open: boolean;
  now: number;
  onToggle?: () => void;
}) {
  return (
    <div
      class="th"
      {...(onToggle ? { ...press(onToggle), 'aria-expanded': open } : {})}
      data-tip={onToggle ? v().toggleTurn : undefined}
    >
      <span class="mute">{open ? '▾' : '▸'}</span>
      <span>
        <b>{v().turnTitle(g.turnNo)}</b> · {clock(g.startedAt)} ·{' '}
        {open ? (
          g.live ? (
            <span class="run">{v().live(formatDuration(now - g.startedAt))}</span>
          ) : (
            <span class="mute">{v().done}</span>
          )
        ) : (
          <>
            {g.kinds} <Marks g={g} />
          </>
        )}
      </span>
      <span>{g.tokens > 0 ? compactTokens(g.tokens) : '—'}</span>
    </div>
  );
}

/** Какие ходы раскрыты: первый — по умолчанию, остальные свёрнуты; клик переключает (локально, не сохраняется). */
function useOpenTurns() {
  const [over, setOver] = useState<Record<number, boolean>>({});
  return {
    isOpen: (g: TurnGroup, first: boolean) => over[g.turnNo] ?? first,
    toggle: (g: TurnGroup, first: boolean) =>
      setOver((o) => ({ ...o, [g.turnNo]: !(o[g.turnNo] ?? first) })),
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

/**
 * Выбранный агент: промпт (3 строки), итог или ошибка, последние вызовы, «транскрипт» / «остановить».
 * `open` — раскрытие на месте в дереве, `ldet` — блок под дорожками (с заголовком и статусом).
 */
export function AgentOpen({
  d,
  variant,
  onStop,
  onTranscript,
}: {
  d: AgentOpenView;
  variant: 'open' | 'ldet';
  onStop: (taskId: string) => void;
  onTranscript: (agentId: string, taskId: string) => void;
}) {
  return (
    <div class={variant}>
      {variant === 'ldet' && (
        <>
          <div class="t">
            {d.title} <span class="ty">· {d.type}</span>
          </div>
          <div class="m">
            <span
              class={
                d.status === 'busy'
                  ? 'run'
                  : d.status === 'err'
                    ? 'err'
                    : d.status === 'ok'
                      ? 'ok'
                      : ''
              }
            >
              {d.statusText}
            </span>
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
        </>
      )}
      {d.prompt && (
        <>
          <div class="lbl" data-tip={v().estTip}>
            {d.promptLabel}
          </div>
          <div class="q">{d.prompt}</div>
        </>
      )}
      {d.summary && (
        <>
          <div class="lbl" data-tip={d.status === 'err' ? undefined : v().estTip}>
            {d.summaryLabel}
          </div>
          <div class="q">{d.summary}</div>
        </>
      )}
      <div class="lbl">{d.callsLabel}</div>
      {d.rows.length === 0 && <div class="c">{ui.agents.detail.empty}</div>}
      {d.rows.map((r) => (
        <CallRow r={r} />
      ))}
      <div class="ac">
        {d.transcript && (
          <button
            class="btn"
            data-tip={ui.agents.detail.transcriptTitle}
            onClick={() => onTranscript(d.agentId, d.taskId)}
          >
            {v().transcript}
          </button>
        )}
        {d.stopTaskId && (
          <button
            class="btn stop"
            data-tip={ui.agents.stopTitle}
            onClick={() => onStop(d.stopTaskId!)}
          >
            {v().stop}
          </button>
        )}
      </div>
    </div>
  );
}

function StopButton({ taskId, onStop }: { taskId: string; onStop: (id: string) => void }) {
  return (
    <button
      data-tip={ui.agents.stopTitle}
      aria-label={ui.agents.stopTitle}
      onClick={(e) => {
        e.stopPropagation();
        onStop(taskId);
      }}
    >
      ■
    </button>
  );
}

// ——— Б · дерево ———

function TreeTask({ t, onStop }: { t: TaskLine; onStop: (id: string) => void }) {
  return (
    <li>
      <div class={t.cls.includes('busy') ? 'nd is-busy' : 'nd'}>
        <span class={t.cls.includes('busy') ? 'run' : t.mark === '✕' ? 'err' : 'mute'}>
          {t.mark}
        </span>
        <span class="nm">
          <span class="ty">{v().shellKind} ·</span> {t.name}
          <small>
            {[t.since !== undefined && v().sinceTurn(t.since), t.meta].filter(Boolean).join(' · ')}
          </small>
        </span>
        <span class="tk">
          {t.stopTaskId && <StopButton taskId={t.stopTaskId} onStop={onStop} />}
        </span>
      </div>
    </li>
  );
}

function TreeKids({
  g,
  parent,
  pane,
  act,
}: {
  g: TurnGroup;
  parent: string | undefined;
  pane: ViewsPane;
  act: AgentViewActions;
}) {
  const lines = g.agents.filter((a) => a.parentId === parent);
  if (lines.length === 0) return null;
  return (
    <ul class="kids">
      {lines.map((a) => (
        <TreeNode key={a.agentId} g={g} a={a} pane={pane} act={act} />
      ))}
    </ul>
  );
}

function TreeNode({
  g,
  a,
  pane,
  act,
}: {
  g: TurnGroup;
  a: AgentLine;
  pane: ViewsPane;
  act: AgentViewActions;
}) {
  const sel = pane.selectedId === a.agentId;
  return (
    <li class={sel ? 'sel' : undefined}>
      <div
        class={`nd is-${a.status}`}
        {...press(() => act.onSelect(a.agentId))}
        aria-pressed={sel}
        data-agent={a.agentId}
      >
        <Mark status={a.status} mark={a.mark} />
        <span class="nm">
          <span class="ty">{a.type} ·</span> {a.title}
          <small>{a.brief}</small>
        </span>
        <span class="tk">
          {a.tokens} · {a.time}
          {a.stopTaskId && <StopButton taskId={a.stopTaskId} onStop={act.onStop} />}
        </span>
      </div>
      {sel && pane.open && (
        <AgentOpen
          d={pane.open}
          variant="open"
          onStop={act.onStop}
          onTranscript={act.onTranscript}
        />
      )}
      <TreeKids g={g} parent={a.agentId} pane={pane} act={act} />
    </li>
  );
}

export function AgentsTree({
  pane,
  now,
  act,
  onScope,
  onGraph,
}: {
  pane: ViewsPane;
  now: number;
  act: AgentViewActions;
  onScope: (scope: 'turn' | 'session') => void;
  onGraph?: () => void;
}) {
  const turns = useOpenTurns();
  return (
    <div class="am" data-view="tree">
      <Top
        pane={pane}
        onScope={onScope}
        {...(onGraph ? { onGraph } : {})}
        right={
          <>
            {v().agentsTokens} <b>{pane.tokens}</b>
          </>
        }
      />
      {pane.groups.length === 0 && <div class="empty">{v().empty}</div>}
      {pane.groups.map((g, i) => {
        const open = pane.scope === 'turn' || turns.isOpen(g, i === 0);
        return (
          <div class="turn" key={g.turnNo}>
            <TurnHead
              g={g}
              open={open}
              now={now}
              {...(pane.scope === 'session' ? { onToggle: () => turns.toggle(g, i === 0) } : {})}
            />
            {open && (
              <>
                {i === 0 && (
                  <div class="nd main">
                    <span class={pane.main.mark === '●' ? 'ok' : 'mute'}>{pane.main.mark}</span>
                    <span class="nm">
                      {pane.main.name} <span class="ty">· {pane.main.meta.split(' · ')[0]}</span>
                      <small>{pane.main.meta.split(' · ').slice(1).join(' · ')}</small>
                    </span>
                    <span class="tk">{pane.main.tokens}</span>
                  </div>
                )}
                <TreeKids g={g} parent={undefined} pane={pane} act={act} />
                {g.tasks.length > 0 && (
                  <ul class="kids bg">
                    {g.tasks.map((t) => (
                      <TreeTask key={t.agentId} t={t} onStop={act.onStop} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ——— В · дорожки ———

function Lanes({
  lv,
  pane,
  main,
  act,
}: {
  lv: LaneView;
  pane: ViewsPane;
  main: string;
  act: AgentViewActions;
}) {
  return (
    <div class="lanes">
      <div class="ax" aria-label={v().axisAria}>
        <span />
        <span class="sc">
          {lv.axis.map((t) => (
            <span style={{ left: `${t.pct}%` }}>{t.label}</span>
          ))}
        </span>
      </div>
      {lv.lanes.map((l) => {
        const sel = !!l.agentId && l.agentId === pane.selectedId;
        const pick = l.agentId;
        return (
          <div
            class={sel ? 'ln sel' : 'ln'}
            key={l.key}
            data-lane={l.agentId ?? l.key}
            {...(pick ? { ...press(() => act.onSelect(pick)), 'aria-pressed': sel } : {})}
          >
            <span class="lb">
              <b data-tip={l.title}>{l.label}</b>
              {l.main ? (
                <span>{main}</span>
              ) : (
                <>
                  {l.shell ? (
                    <span class={l.status === 'busy' ? 'run' : l.status === 'err' ? 'err' : 'mute'}>
                      {l.mark}
                    </span>
                  ) : (
                    l.status && l.mark && <Mark status={l.status} mark={l.mark} />
                  )}{' '}
                  <span>{l.sub}</span>
                </>
              )}
            </span>
            <span class="trk">
              {l.bars.map((b) => (
                <i
                  class={`bar ${b.cls}`}
                  style={{ left: `${b.from}%`, width: `${b.to - b.from}%` }}
                  {...(b.before ? { 'data-tip': v().before } : {})}
                >
                  {b.before && <span class="bf">↤</span>}
                  {b.ticks?.map((t) => (
                    <i style={{ left: `${t}%` }} />
                  ))}
                </i>
              ))}
              {l.now !== undefined && (
                <i class="now" style={{ left: `${l.now}%` }} aria-label={v().nowAria} />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function AgentsLanes({
  pane,
  now,
  act,
  onScope,
  onGraph,
}: {
  pane: ViewsPane;
  now: number;
  act: AgentViewActions;
  onScope: (scope: 'turn' | 'session') => void;
  onGraph?: () => void;
}) {
  const turns = useOpenTurns();
  const first = pane.groups[0];
  const mainStatus = pane.main.meta.split(' · ').slice(1).join(' · ');
  return (
    <div class="am" data-view="lanes">
      <Top
        pane={pane}
        onScope={onScope}
        {...(onGraph ? { onGraph } : {})}
        right={
          <>
            {first
              ? `${formatDuration(pane.scope === 'turn' && first.live ? now - first.startedAt : (first.endedAt ?? now) - first.startedAt)} · `
              : ''}
            <b>{pane.tokens}</b>
          </>
        }
      />
      {pane.groups.length === 0 && <div class="empty">{v().empty}</div>}
      {pane.groups.map((g, i) => {
        const open = pane.scope === 'turn' || turns.isOpen(g, i === 0);
        const lv = open ? pane.laneOf(i) : undefined;
        return (
          <div class="turn" key={g.turnNo}>
            {pane.scope === 'session' && (
              <TurnHead g={g} open={open} now={now} onToggle={() => turns.toggle(g, i === 0)} />
            )}
            {open && lv && <Lanes lv={lv} pane={pane} main={i === 0 ? mainStatus : ''} act={act} />}
            {open && pane.open && g.agents.some((a) => a.agentId === pane.selectedId) && (
              <AgentOpen
                d={pane.open}
                variant="ldet"
                onStop={act.onStop}
                onTranscript={act.onTranscript}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ——— Г · карточки ———

function Card({ c, act }: { c: CardView; act: AgentViewActions }) {
  const l = c.line;
  const body =
    l.status === 'busy'
      ? `${c.live ?? ''} · ${ui.agents.nthCall(c.calls)}`
      : l.status === 'stop'
        ? ui.agents.stopped
        : c.excerpt || (l.status === 'err' ? ui.agents.failed : ui.agents.done);
  return (
    <div
      class={l.status === 'busy' ? 'card is-busy' : l.status === 'err' ? 'card is-err' : 'card'}
      data-agent={l.agentId}
    >
      <div class="ch">
        <Mark status={l.status} mark={l.mark} />
        <span>{c.kind}</span>
        <span class="r">
          <b>{l.tokens}</b> · {l.time}
        </span>
      </div>
      <div class="ct">{l.title}</div>
      <div class="cb">{body}</div>
      {c.cells.length > 0 && (
        <div class="prog" aria-hidden="true">
          {c.cells.map((x) => (
            <i class={x || undefined} />
          ))}
        </div>
      )}
      <div class="cf">
        <span data-tip={c.resultEst ? v().estTip : undefined}>
          {c.resultEst ? v().resultToMain(c.resultEst) : v().calls(c.calls)}
        </span>
        <span class="sp">
          {c.transcript && (
            <button
              data-tip={ui.agents.detail.transcriptTitle}
              onClick={() => act.onTranscript(l.agentId, l.taskId)}
            >
              {l.status === 'err' ? v().log : v().transcript}
            </button>
          )}
          {l.stopTaskId && (
            <button
              class="err"
              data-tip={ui.agents.stopTitle}
              onClick={() => act.onStop(l.stopTaskId!)}
            >
              {v().stopShort}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function AgentsCards({
  pane,
  now,
  act,
  onScope,
  onGraph,
}: {
  pane: ViewsPane;
  now: number;
  act: AgentViewActions;
  onScope: (scope: 'turn' | 'session') => void;
  onGraph?: () => void;
}) {
  const turns = useOpenTurns();
  return (
    <div class="am" data-view="cards">
      <Top
        pane={pane}
        onScope={onScope}
        {...(onGraph ? { onGraph } : {})}
        right={pane.statusLine}
      />
      {pane.groups.length === 0 && <div class="empty">{v().empty}</div>}
      {pane.groups.map((g, i) => {
        const open = pane.scope === 'turn' || turns.isOpen(g, i === 0);
        return (
          <div class="turn" key={g.turnNo}>
            {pane.scope === 'session' && (
              <TurnHead g={g} open={open} now={now} onToggle={() => turns.toggle(g, i === 0)} />
            )}
            {open && (
              <>
                {i === 0 && (
                  <div class="mainl">
                    <span class={pane.main.mark === '●' ? 'ok' : 'mute'}>{pane.main.mark}</span>
                    <span>
                      {pane.main.name} <span class="mute">· {pane.main.meta.split(' · ')[0]}</span>
                      <small>{pane.main.meta.split(' · ').slice(1).join(' · ')}</small>
                    </span>
                    <span class="mute">{pane.main.tokens}</span>
                  </div>
                )}
                <div class="cards">
                  {pane.cardsOf(i).map((c) => (
                    <Card key={c.line.agentId} c={c} act={act} />
                  ))}
                </div>
                {g.tasks.length > 0 && (
                  <>
                    <h5>{v().bg}</h5>
                    <div class="chips">
                      {g.tasks.map((t) => (
                        <span class="chip" key={t.agentId}>
                          <span class={t.cls.includes('busy') ? 'run' : 'mute'}>{t.mark}</span>
                          <b>{t.name}</b> {t.meta}
                          {t.stopTaskId && <StopButton taskId={t.stopTaskId} onStop={act.onStop} />}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
