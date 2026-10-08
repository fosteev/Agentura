/**
 * Сообщения хоста расширения (всплывашки, QuickPick, заголовки вкладок, тексты, уходящие в webview)
 * на русском и английском. Без `vscode`: модуль импортируют и те, что тестируются без него.
 * Язык — `currentLanguage()` из webviewHost.ts; смена языка = перезагрузка окна (решение roadmap 07).
 * Сюда НЕ входят логи, текст для модели и отладочная панель.
 */

export type Lang = 'ru' | 'en';

/** Русское число: 1 файл, 2 файла, 5 файлов (11–14 — «многие»). */
function ruPlural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

const ru = {
  /** Локаль для дат и чисел (`toLocaleString`). */
  locale: 'ru',

  // команды и всплывашки
  noSessions: 'Agentura: в этом проекте пока нет сессий.',
  pickSessionPlaceholder: 'Какую сессию возобновить?',
  bindTaskPrompt: 'Ключ задачи (NEWMFC-1482) или ссылка на неё',
  bindTaskBad: 'Не похоже на ключ задачи или ссылку на неё.',
  bindTaskNoInstance: 'Для ключа без ссылки нужна уже известная Jira: вставьте ссылку на задачу.',
  bindTaskPickInstance: 'В какой Jira задача?',
  bindTaskNoTab: 'Agentura: нет открытой вкладки чата.',

  // Jira: источники, подключение, чат по задаче (roadmap 19)
  jiraOff: 'Jira отключена настройкой agentura.jira.source.',
  jiraNoSource: 'Jira не подключена: установите Jiraffe или выполните «Agentura: Подключить Jira…».',
  jiraTimeout: 'Источник Jira не ответил вовремя.',
  jiraUnknownInstance: (id: string) =>
    `Источник Jira не знает инстанс «${id}»: добавьте его в Jiraffe (и в набор воркспейса) или подключите через «Agentura: Подключить Jira…».`,
  jiraConnectUrlTitle: 'Подключение Jira (1/5): адрес',
  jiraConnectUrlPrompt: 'Адрес с context path, если он есть: https://host или https://host/jira. Можно вставить ссылку на задачу.',
  jiraConnectUrlBad: 'Не похоже на адрес',
  jiraConnectUrlScheme: 'Нужен адрес http(s)',
  jiraConnectInsecure: (url: string) => `${url}: адрес не https — токен пойдёт по сети открытым текстом. Продолжить?`,
  jiraConnectContinue: 'Продолжить',
  jiraConnectReplace: (id: string) => `Подключение ${id} уже есть. Заменить?`,
  jiraConnectReplaceButton: 'Заменить',
  jiraConnectKindPlaceholder: 'Подключение Jira (2/5): тип',
  jiraConnectKindCloud: 'почта + API-токен',
  jiraConnectEmailTitle: 'Подключение Jira (3/5): почта',
  jiraConnectEmailPrompt: 'Почта аккаунта Atlassian',
  jiraConnectEmailBad: 'Нужна почта',
  jiraConnectTokenTitle: 'Подключение Jira (4/5): токен',
  jiraConnectTokenPromptCloud: 'API-токен Atlassian',
  jiraConnectTokenPromptDc: 'Personal Access Token',
  jiraConnectTokenEmpty: 'Токен пуст',
  jiraConnectTokenBad: 'В токене пробелы или недопустимые символы',
  jiraConnectProgress: (url: string) => `Agentura: подключаюсь к ${url}…`,
  jiraConnectFailed: (err: string) => `Agentura: не удалось подключиться — ${err}`,
  jiraConnectNameTitle: 'Подключение Jira (5/5): название',
  jiraConnectNamePrompt: (who: string) => `Вы вошли как ${who}. Как назвать подключение?`,
  jiraConnectNameEmpty: 'Название пусто',
  jiraConnected: (name: string) => `Agentura: подключение «${name}» добавлено.`,
  jiraDisconnectNone: 'Agentura: своих подключений Jira нет.',
  jiraDisconnectPick: 'Какое подключение отключить?',
  jiraDisconnectConfirm: (name: string) => `Отключить «${name}» и удалить его токен?`,
  jiraDisconnectButton: 'Отключить',
  jiraDisconnected: (name: string) => `Agentura: подключение «${name}» удалено.`,
  jiraTestPick: 'Какое подключение проверить?',
  jiraTestOk: (name: string, who: string) => `Agentura: «${name}» — вы вошли как ${who}.`,
  jiraTestFailed: (name: string, err: string) => `Agentura: «${name}» — ${err}`,
  chatForTaskProgress: (key: string) => `Agentura: загружаю ${key}…`,
  chatForTaskFailed: (key: string, err: string) =>
    `Agentura: не удалось загрузить ${key} (${err}); чат открыт без данных задачи.`,
  chatForTaskNoSource: (key: string) =>
    `Agentura: Jira не подключена — чат по ${key} не открыт. Подключите Jira или установите Jiraffe.`,
  chatForTaskConnect: 'Подключить Jira…',
  chatForTaskJiraffe: 'Установить Jiraffe',
  taskBound: (key: string) => `Agentura: чат привязан к ${key}.`,
  taskUnbound: 'Agentura: чат отвязан от задачи.',
  taskNotBound: 'Agentura: чат не привязан к задаче.',
  feedStylePlaceholder: 'Вид ленты чата',
  composerLayoutPlaceholder: 'Раскладка поля ввода',
  sidebarLimitsPlaceholder: 'Вид лимитов всех движков в боковой панели',
  taskSidebarPlaceholder: 'Где в боковой панели задачи Jira',
  taskCardPlaceholder: 'Где карточка задачи Jira в чате по задаче',
  taskTabPlaceholder: 'Вкладки редактора для чатов по задаче Jira',
  agentsViewPlaceholder: 'Вид карты агентов',
  gitLayoutPlaceholder: 'Раскладка вкладки git при нескольких репозиториях',
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
  sidebarLimitsViews: {
    stack: ['Стопка', 'карточка на движок, движок текущей вкладки помечен'],
    switch: ['Переключатель', 'вкладки движков, один движок за раз'],
    table: ['Таблица', 'все движки и их окна в одной таблице'],
    active: ['Активный подробно', 'движок текущей вкладки целиком, остальные — по строке'],
    header: ['В заголовке', 'худший лимит каждого движка мини-шкалой, подробности во всплывашке'],
  } as Record<string, [string, string]>,
  taskSidebarViews: {
    groups: ['Группы', 'чаты вложены в список под ключом задачи'],
    section: ['Секция', 'секция «Задачи» над «Сессиями», в строке сессии метка ключа'],
  } as Record<string, [string, string]>,
  taskCardViews: {
    panel: ['Панель', 'вкладка «задача» в правой панели чата'],
    split: ['Сплит', 'карточка Jiraffe слева, чат справа с вкладкой «задача» на изменениях (только с Jiraffe, иначе как «Панель»)'],
    strip: ['Полоска', 'только полоска над лентой, без вкладки'],
  } as Record<string, [string, string]>,
  taskTabViews: {
    chat: ['Вкладка на чат', 'каждый чат в своей вкладке редактора, как без задач'],
    task: ['Вкладка на задачу', 'одна вкладка на задачу, её чаты — внутренними вкладками'],
  } as Record<string, [string, string]>,
  composerLayouts: {
    classic: ['Классика', 'как раньше: полоса блоков, поле, ряд настроек и приборы'],
    card: ['Карточка', 'одна рамка: поле, внизу режим, движок, кольцо контекста и отправка'],
    statusline: ['Строка состояния', 'поле без рамки и полоса состояния под ним'],
    gauges: ['Приборы сверху', 'контекст, кэш и лимиты над полем, настройки внизу'],
    minimal: ['Минимум', 'одна строка; приборы появляются, только когда что-то не в порядке'],
    shell: ['Командная строка', 'как приглашение терминала: проект, режим, движок и поле'],
  } as Record<string, [string, string]>,
  agentsViews: {
    list: ['Список', 'агенты последнего хода и детали выбранного'],
    tree: ['Дерево', 'сессия деревом, агенты — ветками'],
    lanes: ['Дорожки', 'ось времени и дорожка на каждого агента'],
    cards: ['Карточки', 'карточка на агента с текущим вызовом или итогом'],
    graph: ['Граф', 'карта во вкладке редактора (в панели остаётся список)'],
  } as Record<string, [string, string]>,
  gitLayouts: {
    stack: ['Стопка', 'раздел на каждый репозиторий, у каждого своё поле коммита'],
    picker: ['Выбор', 'репозитории сверху, ниже выбранный'],
    unified: ['Общий список', 'один список файлов и один коммит в несколько репозиториев'],
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
  /** Вкладка графа агентов (roadmap 11): «Агенты · <название сессии>». */
  agentsGraphTitle: (session?: string) => (session ? `Агенты · ${session}` : 'Агенты'),
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
  codexNotFound:
    'Не найден Codex CLI (codex). Установите его и выполните вход (codex login) либо укажите путь в настройке agentura.codexExecutable.',
  antigravityNotFound:
    'Не найден Antigravity CLI (agy). Установите его и выполните вход (agy) либо укажите путь в настройке agentura.antigravityExecutable.',
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

  // вкладка «git» (roadmap 12): причины, модалки, QuickPick, заголовки диффа
  gitMissing: 'Встроенное расширение Git не найдено.',
  gitDisabled: 'Git выключен в настройках VS Code (git.enabled).',
  gitFailed: (reason: string) => `Расширение Git не запустилось: ${reason}`,
  gitUnknownRepo: 'Этого репозитория нет среди открытых в рабочей папке.',
  gitOutside: 'Путь вне репозитория.',
  gitDiscard: (n: number) =>
    `Отменить изменения в ${n} ${ruPlural(n, 'файле', 'файлах', 'файлах')}? Это нельзя вернуть.`,
  gitDiscardUntracked: (n: number) =>
    `Удалить ${n} ${ruPlural(n, 'неотслеживаемый файл', 'неотслеживаемых файла', 'неотслеживаемых файлов')}?`,
  gitDiscardAlso: (n: number) => `Неотслеживаемые файлы (${n}) будут удалены.`,
  gitDiscardButton: 'Отменить изменения',
  gitDeleteButton: 'Удалить',
  gitEmptyMessage: 'Пустое сообщение коммита.',
  gitMessageEmptyIndex: 'Индекс пуст — сообщение писать не по чему.',
  gitMessageNoModel: 'Движок не умеет одноразовые запросы — ✦ недоступна.',
  gitMessageBlank: 'Модель вернула пустой ответ.',
  gitDetached: 'HEAD отсоединён от ветки — push некуда.',
  gitNoRemote: 'В репозитории нет remote — push некуда.',
  gitPickRemote: 'Куда опубликовать ветку?',
  gitPickBranch: 'Ветка для checkout',
  gitCreateBranch: 'Создать ветку…',
  gitBranchName: 'Имя новой ветки',
  gitBranchInvalid: 'Имя ветки — без пробелов.',
  gitLocal: 'локальные',
  gitRemote: 'удалённые',
  gitCurrent: 'текущая',
  gitWorkingTree: 'рабочее дерево',
  gitIndex: 'индекс',
  gitDeleted: 'удалён',
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
  bindTaskPrompt: 'Issue key (NEWMFC-1482) or a link to it',
  bindTaskBad: 'This is not an issue key or a link to one.',
  bindTaskNoInstance: 'A bare key needs a Jira that is already known: paste a link to the issue.',
  bindTaskPickInstance: 'Which Jira is the issue in?',
  bindTaskNoTab: 'Agentura: no chat tab is open.',

  // Jira: sources, connection, chat for an issue (roadmap 19)
  jiraOff: 'Jira is turned off by the agentura.jira.source setting.',
  jiraNoSource: 'Jira is not connected: install Jiraffe or run “Agentura: Connect Jira…”.',
  jiraTimeout: 'The Jira source did not respond in time.',
  jiraUnknownInstance: (id) =>
    `The Jira source does not know the instance “${id}”: add it to Jiraffe (and to the workspace set) or connect it with “Agentura: Connect Jira…”.`,
  jiraConnectUrlTitle: 'Connect Jira (1/5): URL',
  jiraConnectUrlPrompt: 'URL with the context path, if any: https://host or https://host/jira. An issue link works too.',
  jiraConnectUrlBad: 'Doesn’t look like a URL',
  jiraConnectUrlScheme: 'An http(s) URL is required',
  jiraConnectInsecure: (url) => `${url}: the URL is not https — the token will be sent over the network in plain text. Continue?`,
  jiraConnectContinue: 'Continue',
  jiraConnectReplace: (id) => `Connection ${id} already exists. Replace?`,
  jiraConnectReplaceButton: 'Replace',
  jiraConnectKindPlaceholder: 'Connect Jira (2/5): type',
  jiraConnectKindCloud: 'email + API token',
  jiraConnectEmailTitle: 'Connect Jira (3/5): email',
  jiraConnectEmailPrompt: 'Atlassian account email',
  jiraConnectEmailBad: 'An email is required',
  jiraConnectTokenTitle: 'Connect Jira (4/5): token',
  jiraConnectTokenPromptCloud: 'Atlassian API token',
  jiraConnectTokenPromptDc: 'Personal Access Token',
  jiraConnectTokenEmpty: 'The token is empty',
  jiraConnectTokenBad: 'The token contains spaces or unexpected characters',
  jiraConnectProgress: (url) => `Agentura: connecting to ${url}…`,
  jiraConnectFailed: (err) => `Agentura: could not connect — ${err}`,
  jiraConnectNameTitle: 'Connect Jira (5/5): name',
  jiraConnectNamePrompt: (who) => `Connected as ${who}. What should the connection be called?`,
  jiraConnectNameEmpty: 'The name is empty',
  jiraConnected: (name) => `Agentura: connection “${name}” added.`,
  jiraDisconnectNone: 'Agentura: no Jira connections of its own.',
  jiraDisconnectPick: 'Which connection to disconnect?',
  jiraDisconnectConfirm: (name) => `Disconnect “${name}” and delete its token?`,
  jiraDisconnectButton: 'Disconnect',
  jiraDisconnected: (name) => `Agentura: connection “${name}” removed.`,
  jiraTestPick: 'Which connection to test?',
  jiraTestOk: (name, who) => `Agentura: “${name}” — connected as ${who}.`,
  jiraTestFailed: (name, err) => `Agentura: “${name}” — ${err}`,
  chatForTaskProgress: (key) => `Agentura: loading ${key}…`,
  chatForTaskFailed: (key, err) => `Agentura: could not load ${key} (${err}); the chat is open without the issue data.`,
  chatForTaskNoSource: (key) =>
    `Agentura: Jira is not connected — the chat for ${key} was not opened. Connect Jira or install Jiraffe.`,
  chatForTaskConnect: 'Connect Jira…',
  chatForTaskJiraffe: 'Install Jiraffe',
  taskBound: (key: string) => `Agentura: chat bound to ${key}.`,
  taskUnbound: 'Agentura: chat unbound from the issue.',
  taskNotBound: 'Agentura: the chat is not bound to an issue.',
  feedStylePlaceholder: 'Chat feed style',
  composerLayoutPlaceholder: 'Composer layout',
  sidebarLimitsPlaceholder: 'Limits view for all engines in the sidebar',
  taskSidebarPlaceholder: 'Where Jira tasks go in the sidebar',
  taskCardPlaceholder: 'Where the Jira task card goes in a task chat',
  taskTabPlaceholder: 'Editor tabs for Jira task chats',
  agentsViewPlaceholder: 'Agents map view',
  gitLayoutPlaceholder: 'Git tab layout for several repositories',
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
  sidebarLimitsViews: {
    stack: ['Stack', "a card per engine, the current tab's engine marked"],
    switch: ['Switch', 'engine tabs, one engine at a time'],
    table: ['Table', 'all engines and their windows in one table'],
    active: ['Active in detail', "the current tab's engine in full, the others as one line each"],
    header: ['In the header', 'the worst limit of each engine as a mini-gauge, details in a popup'],
  } as Record<string, [string, string]>,
  taskSidebarViews: {
    groups: ['Groups', 'chats nested in the list under the task key'],
    section: ['Section', 'a "Tasks" section above "Sessions", a key tag on the session row'],
  } as Record<string, [string, string]>,
  taskCardViews: {
    panel: ['Panel', 'a "task" tab in the chat right panel'],
    split: ['Split', "Jiraffe's card on the left, the chat and a “task” tab on changes on the right (Jiraffe only, otherwise as Panel)"],
    strip: ['Strip', 'only the strip above the feed, no tab'],
  } as Record<string, [string, string]>,
  taskTabViews: {
    chat: ['Tab per chat', 'every chat in its own editor tab, as without tasks'],
    task: ['Tab per task', 'one tab per task, its chats as inner tabs'],
  } as Record<string, [string, string]>,
  composerLayouts: {
    classic: ['Classic', 'as before: block strip, field, settings row and gauges'],
    card: ['Card', 'one frame: field, with mode, engine, context ring and send below'],
    statusline: ['Status line', 'a frameless field with a status bar under it'],
    gauges: ['Gauges on top', 'context, cache and limits above the field, settings below'],
    minimal: ['Minimal', 'a single line; gauges appear only when something is off'],
    shell: ['Shell prompt', 'like a terminal prompt: project, mode, engine and the field'],
  } as Record<string, [string, string]>,
  agentsViews: {
    list: ['List', 'agents of the last turn with details of the selected one'],
    tree: ['Tree', 'the session as a tree, agents as branches'],
    lanes: ['Lanes', 'a time axis with one lane per agent'],
    cards: ['Cards', 'one card per agent with its live call or result'],
    graph: ['Graph', 'a map in an editor tab (the panel keeps the list)'],
  } as Record<string, [string, string]>,
  gitLayouts: {
    stack: ['Stack', 'a section per repository, each with its own commit field'],
    picker: ['Picker', 'repositories on top, the selected one below'],
    unified: ['Unified', 'one list of files and one commit into several repositories'],
  } as Record<string, [string, string]>,
  turns: (n) => `${n} ${n === 1 ? 'turn' : 'turns'}`,
  languageReload: 'Agentura language will apply after the window reloads.',
  reloadButton: 'Reload',
  openFolder: 'Agentura: open a project folder to start a session.',
  gitMissing: 'The built-in Git extension was not found.',
  gitDisabled: 'Git is turned off in VS Code settings (git.enabled).',
  gitFailed: (reason) => `The Git extension failed to start: ${reason}`,
  gitUnknownRepo: 'This repository is not among those open in the workspace folder.',
  gitOutside: 'Path is outside the repository.',
  gitDiscard: (n) =>
    `Discard changes in ${n} ${n === 1 ? 'file' : 'files'}? This cannot be undone.`,
  gitDiscardUntracked: (n) => `Delete ${n} untracked ${n === 1 ? 'file' : 'files'}?`,
  gitDiscardAlso: (n) => `Untracked files (${n}) will be deleted.`,
  gitDiscardButton: 'Discard changes',
  gitDeleteButton: 'Delete',
  gitEmptyMessage: 'The commit message is empty.',
  gitMessageEmptyIndex: 'Nothing is staged — nothing to write a message about.',
  gitMessageNoModel: 'The engine cannot run one-off requests — ✦ is unavailable.',
  gitMessageBlank: 'The model returned an empty reply.',
  gitDetached: 'HEAD is detached from a branch — nothing to push.',
  gitNoRemote: 'The repository has no remote — nowhere to push.',
  gitPickRemote: 'Publish the branch to which remote?',
  gitPickBranch: 'Branch to check out',
  gitCreateBranch: 'Create branch…',
  gitBranchName: 'New branch name',
  gitBranchInvalid: 'A branch name has no spaces.',
  gitLocal: 'local',
  gitRemote: 'remote',
  gitCurrent: 'current',
  gitWorkingTree: 'Working Tree',
  gitIndex: 'Index',
  gitDeleted: 'Deleted',
  addLabel: 'Add',
  previewMissing: (file) => `Agentura: file not found — ${file}`,
  previewTitle: (base) => `preview · ${base}`,
  diffTitle: (name, stage) => `${name}: ${stage === 'proposed' ? 'proposed edit' : 'agent edit'}`,
  changesTitle: (files) => `Agent changes (${files})`,
  settingsTitle: 'Agentura · Settings',
  agentsGraphTitle: (session) => (session ? `Agents · ${session}` : 'Agents'),
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
  codexNotFound:
    'Codex CLI (codex) not found. Install it and sign in (codex login), or set the path in agentura.codexExecutable.',
  antigravityNotFound:
    'Antigravity CLI (agy) not found. Install it and sign in (agy), or set the path in agentura.antigravityExecutable.',
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
