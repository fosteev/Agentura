import { render } from 'preact';
import { Sidebar } from '../components/Sidebar';
import { installAppearance } from '../appearance';
import { installCopyKeys } from '../copyKeys';
import { installTooltips } from '../tooltip';
import { send } from '../vscode';

installAppearance();
installTooltips();
installCopyKeys();
render(<Sidebar />, document.getElementById('root')!);
send({ type: 'ready' });
