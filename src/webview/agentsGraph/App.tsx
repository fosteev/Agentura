import { AgentsGraph } from '../components/AgentsGraph';
import { graphModel } from './model';
import {
  graphNow,
  graphSelected,
  graphSnap,
  graphTurn,
  openGraphTranscript,
  pickAgent,
  pickTurn,
  stopGraphAgent,
} from './store';

/** Вкладка графа агентов: модель из последнего снимка чата и локального выбора. */
export function GraphApp() {
  const snap = graphSnap.value;
  const model = snap
    ? graphModel(snap.graph, {
        now: graphNow.value,
        hasSession: !!snap.sessionId,
        ...(graphTurn.value !== undefined ? { turn: graphTurn.value } : {}),
        ...(graphSelected.value ? { selected: graphSelected.value } : {}),
      })
    : undefined;
  return (
    <AgentsGraph
      model={model}
      onTurn={pickTurn}
      onSelect={pickAgent}
      onStop={stopGraphAgent}
      onTranscript={openGraphTranscript}
    />
  );
}
