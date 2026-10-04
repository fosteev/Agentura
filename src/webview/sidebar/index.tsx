import { render } from 'preact';
import { Sidebar } from '../components/Sidebar';
import { installAppearance } from '../appearance';
import { installTooltips } from '../tooltip';
import { send } from '../vscode';

installAppearance();
installTooltips();
render(<Sidebar />, document.getElementById('root')!);
send({ type: 'ready' });
