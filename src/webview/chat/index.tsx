import { render } from 'preact';
import { Chat } from '../components/Chat';
import { handleHostMessage } from '../store';
import { installAppearance } from '../appearance';
import { installTooltips } from '../tooltip';
import { forgetSession, host, onHostMessage, send } from '../vscode';
import { installGraphSync } from '../graphSync';

// Слушатель ставим до первого рендера и до `ready`: эффекты Preact выполняются позже, а хост
// отвечает на `ready` сразу — ответ не должен потеряться.
onHostMessage(handleHostMessage);
// снимки для вкладки графа агентов — только пока она открыта
installGraphSync();
installAppearance();
installTooltips();
render(<Chat />, document.getElementById('root')!);
// пустое состояние = «webview жил, сессии нет»: сериализатор не отдаст такой вкладке чужую сессию из
// памяти воркспейса (запасной путь только для вкладок, чей webview ни разу не запускался)
if (host().getState?.() === undefined) forgetSession();
send({ type: 'ready' });
