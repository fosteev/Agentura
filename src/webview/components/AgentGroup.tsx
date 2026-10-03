import { useState } from 'preact/hooks';
import type { GroupView } from '../agentsView';
import { ui } from '../strings';

/**
 * Группа субагентов в ленте под вызовами `Agent`/`Task` (A6, `prototype/screens/agents.html`):
 * строка на агента — тип, задача, живой текущий вызов или итог, токены, время, ■; подвал — фоновые
 * задачи, «карта агентов», «основной ждёт агентов». Готовую группу можно свернуть.
 */
export function AgentGroup({
  g,
  onStop,
  onOpen,
}: {
  g: GroupView;
  onStop: (taskId: string) => void;
  /** Открыть агента на вкладке «агенты»; без id — карта целиком (первый агент группы). */
  onOpen: (agentId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const shut = collapsed && !g.live;
  const link = (label: string, run: () => void) => (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        run();
      }}
    >
      {label}
    </a>
  );
  const first = g.rows[0]?.agentId;
  return (
    <div class="grp">
      <div
        class="gh"
        {...(!g.live
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': !shut,
              style: { cursor: 'pointer' },
              onClick: () => setCollapsed(!collapsed),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                setCollapsed(!collapsed);
              },
            }
          : {})}
      >
        <span class="p" style={g.live ? undefined : { color: 'var(--fg-faint)' }}>
          {g.live ? <span class="spin" /> : shut ? '▸' : '▾'}
        </span>
        <span class="op">agent</span>
        <span class="what">
          {g.what} {g.status && <span class="dim">{g.status}</span>}
        </span>
        <span class="r">
          {g.tokens && (
            <>
              <b>{g.tokens}</b> {ui.agents.group.tokens} ·{' '}
            </>
          )}
          {g.time}
        </span>
      </div>
      {!shut &&
        g.rows.map((r) => (
          <div class={r.cls ? `sa ${r.cls}` : 'sa'} key={r.agentId}>
            <span class="st">{r.spin ? <span class="spin" /> : r.mark}</span>
            <span class="ty">{r.type}</span>
            <span class="ds">
              {r.desc}
              {r.note && (
                <small>
                  {r.arrow && <span class="dim">→ </span>}
                  {r.note}
                </small>
              )}
            </span>
            <span class="r">
              {r.right}
              {r.stopTaskId && (
                <button
                  data-tip={ui.agents.group.stop}
                  aria-label={ui.agents.group.stop}
                  onClick={() => onStop(r.stopTaskId!)}
                >
                  ■
                </button>
              )}
              {r.link &&
                link(r.link === 'summary' ? ui.agents.group.summary : ui.agents.group.log, () =>
                  onOpen(r.agentId),
                )}
            </span>
          </div>
        ))}
      {!shut && (
        <div class="gf">
          {g.background && (
            <span>
              {ui.agents.group.background}:{' '}
              <b style={{ color: 'var(--fg)', fontWeight: 500 }}>{g.background}</b>
            </span>
          )}
          {!g.live && link(ui.agents.group.collapse, () => setCollapsed(true))}
          {first && link(ui.agents.group.map, () => onOpen(first))}
          {g.waiting && <span class="sp">{ui.agents.group.waiting}</span>}
        </div>
      )}
    </div>
  );
}
