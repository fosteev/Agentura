import type { AgentLaunchRecord as LaunchRecord } from '../../agent/types';
import { ui } from '../strings';

/** Separate from native metadata: registration is a declaration, not proof of spawn arguments. */
export function AgentLaunchRecord({ record, classic = false }: { record: LaunchRecord; classic?: boolean }) {
  const v = ui.agents.view;
  return <details>
    <summary style={{ cursor: 'pointer' }}>{v.launchRecorded}</summary>
    <div class="lbl">{v.launchRecorded} · {record.taskName} · {new Date(record.recordedAt).toLocaleString()}</div>
    <div class="lbl">{v.launchUnverified}</div>
    <div class={classic ? 'prm' : 'q'} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      display: 'block', maxHeight: '300px', overflow: 'auto' }}>
      {`model: ${record.model ?? v.launchDefault} · effort: ${record.reasoningEffort ?? v.launchDefault}\n`}
      {`${v.launchContext}: ${record.forkTurns === 'all' ? v.launchContextAll : v.launchContextNone}\n\n`}
      {record.prompt}
    </div>
  </details>;
}
