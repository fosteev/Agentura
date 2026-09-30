import type { AgentRowView, TimelineView } from '../hudView';
import { ui } from '../strings';

export function TurnPane({ turns, hidden }: { turns: TimelineView[]; hidden?: boolean }) {
  return (
    <section class="tabpane" id="pane-turn" hidden={hidden}>
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
                <span class="ev" style={r.mute ? { color: 'var(--fg-mute)' } : undefined}>
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

export function AgentsPane({
  rows,
  totals,
  hidden,
  onStop,
}: {
  rows: AgentRowView[];
  totals: { label: string; value: string }[];
  hidden?: boolean;
  onStop: (taskId: string) => void;
}) {
  return (
    <section class="tabpane" id="pane-agents" hidden={hidden}>
      <h4>{ui.agents.heading}</h4>
      <div class="ag">
        {rows.map((a) => (
          <div class={['a', a.kind, a.busy && 'busy'].filter(Boolean).join(' ')}>
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
              {a.stoppable && a.taskId && (
                <button title={ui.agents.stopTitle} onClick={() => onStop(a.taskId!)}>
                  ■
                </button>
              )}
            </span>
          </div>
        ))}
        {totals.length > 0 && (
          <div class="tot">
            {totals.map((t) => (
              <>
                <span>{t.label}</span>
                <b>{t.value}</b>
              </>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
