import { render } from 'preact';
import { Settings } from '../components/Settings';
import { handleSettingsMessage } from '../settingsStore';
import { installAppearance } from '../appearance';
import { installCopyKeys } from '../copyKeys';
import { installTooltips } from '../tooltip';
import { onHostMessage, send } from '../vscode';

// как у чата: слушатель — до первого рендера и до `ready`
onHostMessage(handleSettingsMessage);
installAppearance();
installTooltips();
installCopyKeys();
render(<Settings />, document.getElementById('root')!);
send({ type: 'ready' });
