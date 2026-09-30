import { render } from 'preact';
import { Sidebar } from '../components/Sidebar';
import { send } from '../vscode';

render(<Sidebar />, document.getElementById('root')!);
send({ type: 'ready' });
