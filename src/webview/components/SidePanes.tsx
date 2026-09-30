import type { AgentRow, Timeline } from '../fixtures/chat';
import { ui } from '../strings';

export function TurnPane({ turns, hidden }: { turns: Timeline[]; hidden?: boolean }) {
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
}: {
  rows: AgentRow[];
  totals: { label: string; value: string }[];
  hidden?: boolean;
}) {
  return (
    <section class="tabpane" id="pane-agents" hidden={hidden}>
      <h4>{ui.agents.heading}</h4>
      <div class="ag">
        {rows.map((a) => (
          <div class={['a', a.kind, a.busy && 'busy'].filter(Boolean).join(' ')}>
            <span class="st">{a.mark}</span>
            <span class="nm">
              {a.name}
              <small>{a.meta}</small>
            </span>
            <span class="tk">
              {a.tokens}
              {a.stoppable && <button title={ui.agents.stopTitle}>■</button>}
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
