import type { SessionSummary } from '../../protocol';
import { clock } from '../chatState';
import { mixedProviders, providerName } from '../sessionsView';
import { ui } from '../strings';

function recentMeta(s: SessionSummary, mixed: boolean): string {
  const when = clock(s.updatedAt);
  // у Codex-треда ходов нет — вместо них метка движка; у Claude она появляется, когда в списке есть и Codex
  const tag = mixed || s.provider === 'codex' ? providerName(s) : '';
  if (s.state === 'waiting') return [ui.empty.waiting, tag, when].filter(Boolean).join(' · ');
  return [s.provider === 'codex' ? '' : ui.empty.turns(s.turns), tag, when].filter(Boolean).join(' · ');
}

/** Экран empty: новая сессия. Недавние сессии приходят с хоста (`sessions.update`). */
export function Empty({
  project,
  recent,
  onResume,
}: {
  project: string;
  recent: SessionSummary[];
  onResume: (id: string) => void;
}) {
  return (
    <div class="empty">
      <div>
        <h2>{ui.empty.title(project)}</h2>
        <p>{ui.empty.lead}</p>
      </div>
      <div class="tips">
        {ui.empty.tips.map(([key, text]) => (
          <div>
            <kbd>{key}</kbd>
            <span>{text}</span>
          </div>
        ))}
      </div>
      {recent.length > 0 && (
        <div>
          <p style={{ color: 'var(--fg-mute)', fontSize: '12px', marginBottom: '4px' }}>
            {ui.empty.recent}
          </p>
          <div class="recent">
            {recent.slice(0, 3).map((s) => (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onResume(s.id);
                }}
              >
                {s.title}
                <span>{recentMeta(s, mixedProviders(recent.slice(0, 3)))}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
