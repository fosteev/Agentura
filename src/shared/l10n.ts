/**
 * Сообщения хоста расширения (всплывашки, QuickPick, заголовки вкладок, тексты, уходящие в webview)
 * на русском и английском. Без `vscode`: модуль импортируют и те, что тестируются без него.
 * Язык — `currentLanguage()` из webviewHost.ts; смена языка = перезагрузка окна (решение roadmap 07).
 * Сюда НЕ входят логи, текст для модели и отладочная панель.
 */

export type Lang = 'ru' | 'en';

const ru = {
  /** Локаль для дат и чисел (`toLocaleString`). */
  locale: 'ru',

  // команды и всплывашки
  noSessions: 'Agentura: в этом проекте пока нет сессий.',
  pickSessionPlaceholder: 'Какую сессию возобновить?',
  feedStylePlaceholder: 'Вид ленты чата',
  feedStyleCurrent: 'сейчас',
  fontPickPlaceholder: 'Шрифт из Google Fonts',
  fontPickLoading: 'Загружаю каталог Google Fonts…',
  fontCyrillic: 'кириллица',
  fontDownloaded: 'скачан',
  fontDownloading: (family: string) => `Скачиваю ${family}…`,
  fontReady: (family: string) => `Шрифт ${family} скачан и доступен в настройках.`,
  fontApply: 'Применить',
  fontFailed: (family: string, reason: string) => `Не удалось скачать ${family}: ${reason}`,
  fontCatalogFailed: (reason: string) => `Каталог Google Fonts недоступен: ${reason}`,
  feedStyles: {
    journal: ['Журнал', 'плоский список строк, как раньше'],
    folded: ['Свёрнуто', 'завершённые ходы прячут действия в одну строку'],
    replies: ['Реплики', 'ваше сообщение пузырём, действия чипами'],
    cards: ['Карточки', 'каждый ход — карточка с лентой действий'],
  } as Record<string, [string, string]>,
  turns: (n: number) => `${n} ${n === 1 ? 'ход' : 'ходов'}`,
  languageReload: 'Язык Agentura применится после перезагрузки окна.',
  reloadButton: 'Перезагрузить',
  openFolder: 'Agentura: откройте папку проекта, чтобы начать сессию.',
  addLabel: 'Добавить',
  previewMissing: (file: string) => `Agentura: файла нет — ${file}`,
  previewTitle: (base: string) => `превью · ${base}`,
  diffTitle: (name: string, stage: 'proposed' | 'applied') =>
    `${name}: ${stage === 'proposed' ? 'предложенная правка' : 'правка агента'}`,
  changesTitle: (files: number) => `Правки агента (${files})`,
  settingsTitle: 'Agentura · настройки',
  /** Заголовок вкладки чата, пока у сессии нет названия. */
  untitledTab: 'Новая сессия',
  overriddenView:
    'Agentura: вид списка задан в настройках рабочей папки (agentura.sessionList.view) — поменяйте его там.',
  renameFailed: (e: string) => `Agentura: не удалось переименовать сессию: ${e}`,

  // вкладка настроек
  bypassNotAllowed:
    'Сначала включите «Разрешить режим «без разрешений»» (agentura.allowBypassPermissions).',
  writeFailed: (message: string) => `Не удалось записать: ${message}`,

  // аккаунт
  loginCli: 'через CLI · ок',
  loginApiKey: 'ключ API',
  loginOk: (source: string) => `${source} · ок`,

  // карточка правки
  editFragment: '@@ фрагмент правки @@',

  // повтор запроса к API (плашка в ленте)
  apiRetry: (attempt: number, max: number, status?: number) =>
    `Повтор запроса к API ${attempt}/${max}${status ? ` (HTTP ${status})` : ''}`,

  // поиск движка
  engineNotFound:
    'Не найден Claude Code (claude). Установите его и выполните вход (claude → /login) либо укажите путь в настройке agentura.claudeExecutable.',
  engineNotFoundShort: 'Не найден Claude Code (claude).',
  engineWrapper: (path: string) =>
    `${path} — npm-обёртка, движок через неё не запускается. Установите Claude Code нативным установщиком (claude.exe) или укажите путь к claude.exe в agentura.claudeExecutable.`,
  engineOld: (min: string, found: string, path: string) =>
    `Agentura проверена на Claude Code ${min}+, найден ${found} (${path}). Обновите: claude update.`,
  engineSettingBroken: (setting: string) =>
    `agentura.claudeExecutable: «${setting}» не запускается (claude --version).`,

  // лимиты
  limitThrottled: (time: string) => `лимит запросов к /api/oauth/usage, повтор после ${time}`,
  limitNoNetwork: 'нет сети',
  limitUnauthorized: 'вход отклонён (HTTP 401) — войдите в claude заново',
  limitForbidden: 'сервер отклонил запрос (HTTP 403)',
  limitNotJson: 'ответ не JSON',
  limitNoWindows: 'в ответе /api/oauth/usage нет окон лимитов',
  limitKeychainOff:
    'нет ~/.claude/.credentials.json, а чтение токена из Keychain выключено — включите чтение токена (agentura.limits.readKeychain)',
  limitNoToken: 'нет токена Claude Code (войдите в claude)',

  // транскрипт субагента (документ только для чтения)
  agentReadOnly: '_Транскрипт субагента только для чтения._',
  agentMessage: '## Сообщение',
  agentPrompt: '## Промпт от основного',
  agentError: '_ошибка:_',
  agentResult: '_результат:_',
  agentThinking: '_думает:_',
  agentClipped: (chars: number) => `… (обрезано: ${chars} симв.)`,
};

export type HostUi = typeof ru;

const en: HostUi = {
  locale: 'en',

  noSessions: 'Agentura: no sessions in this project yet.',
  pickSessionPlaceholder: 'Which session to resume?',
  feedStylePlaceholder: 'Chat feed style',
  feedStyleCurrent: 'current',
  fontPickPlaceholder: 'Google Fonts family',
  fontPickLoading: 'Loading the Google Fonts catalog…',
  fontCyrillic: 'Cyrillic',
  fontDownloaded: 'downloaded',
  fontDownloading: (family: string) => `Downloading ${family}…`,
  fontReady: (family: string) => `${family} downloaded and available in settings.`,
  fontApply: 'Apply',
  fontFailed: (family: string, reason: string) => `Could not download ${family}: ${reason}`,
  fontCatalogFailed: (reason: string) => `Google Fonts catalog unavailable: ${reason}`,
  feedStyles: {
    journal: ['Journal', 'a flat log of rows, as before'],
    folded: ['Folded', 'finished turns collapse their actions into one line'],
    replies: ['Replies', 'your message as a bubble, actions as chips'],
    cards: ['Cards', 'each turn is a card with a timeline of actions'],
  } as Record<string, [string, string]>,
  turns: (n) => `${n} ${n === 1 ? 'turn' : 'turns'}`,
  languageReload: 'Agentura language will apply after the window reloads.',
  reloadButton: 'Reload',
  openFolder: 'Agentura: open a project folder to start a session.',
  addLabel: 'Add',
  previewMissing: (file) => `Agentura: file not found — ${file}`,
  previewTitle: (base) => `preview · ${base}`,
  diffTitle: (name, stage) => `${name}: ${stage === 'proposed' ? 'proposed edit' : 'agent edit'}`,
  changesTitle: (files) => `Agent changes (${files})`,
  settingsTitle: 'Agentura · Settings',
  untitledTab: 'New session',
  overriddenView:
    'Agentura: the list view is set in the workspace settings (agentura.sessionList.view) — change it there.',
  renameFailed: (e) => `Agentura: could not rename the session: ${e}`,

  bypassNotAllowed:
    'First enable “Allow bypass permissions mode” (agentura.allowBypassPermissions).',
  writeFailed: (message) => `Could not save: ${message}`,

  loginCli: 'via CLI · ok',
  loginApiKey: 'API key',
  loginOk: (source) => `${source} · ok`,

  editFragment: '@@ edit fragment @@',

  apiRetry: (attempt, max, status) =>
    `Retrying API request ${attempt}/${max}${status ? ` (HTTP ${status})` : ''}`,

  engineNotFound:
    'Claude Code (claude) not found. Install it and sign in (claude → /login), or set the path in agentura.claudeExecutable.',
  engineNotFoundShort: 'Claude Code (claude) not found.',
  engineWrapper: (path) =>
    `${path} is an npm wrapper; the engine cannot run through it. Install Claude Code with the native installer (claude.exe) or set the path to claude.exe in agentura.claudeExecutable.`,
  engineOld: (min, found, path) =>
    `Agentura is tested with Claude Code ${min}+, found ${found} (${path}). Update with: claude update.`,
  engineSettingBroken: (setting) =>
    `agentura.claudeExecutable: “${setting}” does not run (claude --version).`,

  limitThrottled: (time) => `rate limit on /api/oauth/usage, retry after ${time}`,
  limitNoNetwork: 'no network',
  limitUnauthorized: 'sign-in rejected (HTTP 401) — sign in to claude again',
  limitForbidden: 'the server rejected the request (HTTP 403)',
  limitNotJson: 'response is not JSON',
  limitNoWindows: 'no limit windows in the /api/oauth/usage response',
  limitKeychainOff:
    'no ~/.claude/.credentials.json and reading the token from Keychain is off — enable token reading (agentura.limits.readKeychain)',
  limitNoToken: 'no Claude Code token (sign in to claude)',

  agentReadOnly: '_Subagent transcript, read-only._',
  agentMessage: '## Message',
  agentPrompt: '## Prompt from the main agent',
  agentError: '_error:_',
  agentResult: '_result:_',
  agentThinking: '_thinking:_',
  agentClipped: (chars) => `… (truncated: ${chars} chars)`,
};

export function hostStrings(lang: Lang): HostUi {
  return lang === 'en' ? en : ru;
}
