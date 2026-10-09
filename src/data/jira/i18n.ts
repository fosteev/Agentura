// Agentura: замена `src/l10n.ts` Jiraffe для скопированного слоя. Ключ — английский текст сообщения (как в Jiraffe),
// русский перевод — в таблице ниже; язык задаёт хост (`setJiraLang`, как `currentLanguage()`).
import type { Lang } from '../../shared/l10n';

let lang: Lang = 'en';

export function setJiraLang(l: Lang): void {
  lang = l;
}

const RU: Record<string, string> = {
  'The token contains spaces, line breaks or non-ASCII characters. Copy it again.':
    'В токене есть пробелы, переводы строк или не-ASCII символы. Скопируйте его заново.',
  'No response from {0}: timed out': 'Нет ответа от {0}: таймаут',
  'No connection to {0}: {1}': 'Нет соединения с {0}: {1}',
  'The server redirected to {0}. Use this instance URL.': 'Сервер перенаправил на {0}. Укажите этот адрес инстанса.',
  'The response from {0} was cut off (timeout or connection lost)': 'Ответ от {0} оборвался (таймаут или обрыв соединения)',
  'The response is not JSON. Check the instance URL (a context path such as /jira may be needed).':
    'Ответ не JSON. Проверьте адрес инстанса (может понадобиться context path, например /jira).',
  'Not authorized: check the token (and email for Cloud)': 'Нет авторизации: проверьте токен (и email для Cloud)',
  'Access denied: the token has no permission for this resource': 'Доступ запрещён: у токена нет прав на этот ресурс',
  'Not found: check the instance URL and the key': 'Не найдено: проверьте адрес инстанса и ключ задачи',
  'Jira error (HTTP {0})': 'Ошибка Jira (HTTP {0})',
  'The response from {0} is too large': 'Ответ от {0} слишком большой',
  '{0}. The server certificate is not trusted. A corporate CA can be added via NODE_EXTRA_CA_CERTS.':
    '{0}. Сертификат сервера не доверенный. Корпоративный CA можно добавить через NODE_EXTRA_CA_CERTS.',
  // запись (этап 8): переводы — из bundle.l10n.ru.json Jiraffe
  'the write may have been saved; check the issue log before retrying':
    'запись могла сохраниться — проверьте журнал задачи, прежде чем повторять',
  'The URL does not belong to the instance. Authorized request is blocked.':
    'Адрес не относится к инстансу — запрос с авторизацией запрещён',
  'No response from {0}: timed out; {1}': 'Нет ответа от {0}: превышено время ожидания; {1}',
  'Jira redirected to the login page. The token is invalid or lacks write access.':
    'Jira перенаправила на страницу входа — токен недействителен или нет прав на запись',
  'The server redirected a write request. Request canceled; check the instance URL (https, context path).':
    'Сервер ответил перенаправлением на запись — запрос отменён; проверьте адрес инстанса (https, context path)',
  'The response from {0} was cut off; {1}': 'Ответ от {0} оборвался; {1}',
  'The write response is not JSON; {0}': 'Ответ на запись не похож на JSON; {0}',
};

/** Сообщение на языке хоста; `{0}`, `{1}` — подстановки. */
export function t(message: string, ...args: (string | number)[]): string {
  const s = lang === 'ru' ? (RU[message] ?? message) : message;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}
