import { render } from 'preact';
import { Chat } from '../components/Chat';
import { send } from '../vscode';

render(<Chat />, document.getElementById('root')!);
send({ type: 'ready' });
