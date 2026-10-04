import { render } from 'preact';
import { installAppearance } from '../appearance';
import { installTooltips } from '../tooltip';
import { onHostMessage, send } from '../vscode';
import { GraphApp } from './App';
import { graphLive, graphNow, handleGraphMessage, restoreGraphState } from './store';

// как у чата: слушатель — до первого рендера и до `ready`
onHostMessage(handleGraphMessage);
installAppearance();
installTooltips();
restoreGraphState();
// таймеры идущих агентов — раз в секунду, пока что-то идёт
setInterval(() => {
  if (graphLive()) graphNow.value = Date.now();
}, 1000);
render(<GraphApp />, document.getElementById('root')!);
send({ type: 'ready' });
