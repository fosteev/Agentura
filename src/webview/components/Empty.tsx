import type { SessionSummary } from '../../protocol';
import { clock } from '../chatState';
import { ui } from '../strings';

function recentMeta(s: SessionSummary): string {
  const when = clock(s.updatedAt);
  if (s.state === 'waiting') return `${ui.empty.waiting} · ${when}`;
  return `${ui.empty.turns(s.turns)} · ${when}`;
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
                <span>{recentMeta(s)}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
