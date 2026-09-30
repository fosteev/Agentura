import { render } from 'preact';
import { Chat } from '../components/Chat';
import { handleHostMessage } from '../store';
import { onHostMessage, send } from '../vscode';

// Слушатель ставим до первого рендера и до `ready`: эффекты Preact выполняются позже, а хост
// отвечает на `ready` сразу — ответ не должен потеряться.
onHostMessage(handleHostMessage);
render(<Chat />, document.getElementById('root')!);
send({ type: 'ready' });
