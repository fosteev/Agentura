import { render } from 'preact';
import { Settings } from '../components/Settings';
import { handleSettingsMessage } from '../settingsStore';
import { installTooltips } from '../tooltip';
import { onHostMessage, send } from '../vscode';

// как у чата: слушатель — до первого рендера и до `ready`
onHostMessage(handleSettingsMessage);
installTooltips();
render(<Settings />, document.getElementById('root')!);
send({ type: 'ready' });
