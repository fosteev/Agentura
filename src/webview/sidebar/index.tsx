import { render } from 'preact';
import { Sidebar } from '../components/Sidebar';
import { installTooltips } from '../tooltip';
import { send } from '../vscode';

installTooltips();
render(<Sidebar />, document.getElementById('root')!);
send({ type: 'ready' });
