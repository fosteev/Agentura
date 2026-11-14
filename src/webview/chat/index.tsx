import { render } from 'preact';
import { Chat } from '../components/Chat';
import { handleHostMessage, sessionLoading } from '../store';
import { installAppearance } from '../appearance';
import { installCopyKeys } from '../copyKeys';
import { installTooltips } from '../tooltip';
import { forgetSession, host, onHostMessage, readBootSession, send } from '../vscode';
import { installGraphSync } from '../graphSync';

// Слушатель ставим до первого рендера и до `ready`: эффекты Preact выполняются позже, а хост
// отвечает на `ready` сразу — ответ не должен потеряться.
onHostMessage(handleHostMessage);
// снимки для вкладки графа агентов — только пока она открыта
installGraphSync();
installAppearance();
installTooltips();
installCopyKeys();
const bootSession = readBootSession();
if (bootSession !== undefined) sessionLoading.value = { sessionId: bootSession, boot: true };
const root = document.getElementById('root')!;
root.replaceChildren();
render(<Chat />, root);
// пустое состояние = «webview жил, сессии нет»: сериализатор не отдаст такой вкладке чужую сессию из
// памяти воркспейса (запасной путь только для вкладок, чей webview ни разу не запускался)
if (host().getState?.() === undefined) forgetSession();
send({ type: 'ready' });
