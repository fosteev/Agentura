// Скопировано из fosteev/jiraffe 0.7.0 src/jira/http.ts. Правки помечены «Agentura:».
// Agentura: оставлены `HttpClient.getJson`, `postJson` (этап 8 roadmap 19 — запись агентом: как есть, с `isOwnUrl` и
// `maybeSaved`) и вспомогательное для них; `getBinary` и `canonicalBaseUrl` не копировались (последний уже есть в
// ../../extension/taskLink.ts); `../l10n` → `./i18n`; ответ `getJson` и `postJson` читается с потолком `maxBytes` (код `limit`).
import { t } from './i18n';
import type { InstanceKind } from './types';

/** Хвост сообщения об ошибке записи, после которой запрос мог дойти до Jira (таймаут, обрыв, 5xx прокси, не-JSON 2xx). */
/** Потолок ответа на запись: Jira отдаёт созданный комментарий/ворклог — килобайты (приёмка этапа 8). */
const WRITE_MAX_BYTES = 1024 * 1024;

export const maybeSaved = (): string => t('the write may have been saved; check the issue log before retrying');

export class JiraError extends Error {
  constructor(
    public readonly status: number, // 0 — сеть/таймаут/невалидный ответ
    message: string,
    public readonly url: string,
    /**
     * 'format' — 200, но не JSON (типично: редирект на login.jsp у endpoint'а, которого нет);
     * 'redirect' — сервер увёл на другой origin (http→https, другой хост): fetch снял Authorization.
     * 'blocked' — адрес не принадлежит инстансу (чужой origin/вне context path): авторизованный запрос не отправлен.
     * 'limit' — ответ больше разрешённого размера, скачивание оборвано.
     */
    public readonly code: 'http' | 'network' | 'format' | 'redirect' | 'blocked' | 'limit' = 'http',
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

export interface HttpOptions {
  baseUrl: string;
  kind: InstanceKind;
  token: string;
  email?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Agentura: потолок ответа `getJson`, байт (по умолчанию 20 МБ). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** Agentura: тело ответа текстом, но не больше `max` байт — иначе `onLimit()` (сервер не может съесть память хоста). */
async function readTextLimited(res: Response, max: number, onLimit: () => Error): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) {
    void res.body?.cancel().catch(() => undefined);
    throw onLimit();
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      throw onLimit();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type Query = Record<string, string | number | undefined>;

/** Убирает хвостовые слэши; context path (`/jira`) сохраняется. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Адрес принадлежит инстансу: http(s), тот же origin и путь под context path `baseUrl`.
 * Только на такие адреса уходит `Authorization` (атрибутам из HTML Jira и полям ответа не доверяем).
 */
export function isOwnUrl(url: string, baseUrl: string): boolean {
  try {
    const u = new URL(url);
    const base = new URL(normalizeBaseUrl(baseUrl));
    const root = base.pathname.replace(/\/*$/, '/');
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === base.origin && !u.username && !u.password && u.pathname.startsWith(root);
  } catch {
    return false;
  }
}

export function authHeader(kind: InstanceKind, token: string, email?: string): string {
  if (kind === 'cloud') {
    return 'Basic ' + Buffer.from(`${email ?? ''}:${token}`).toString('base64');
  }
  return `Bearer ${token}`;
}

function describeBody(text: string): string {
  try {
    const j = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown; message?: unknown };
    const parts: string[] = [];
    if (Array.isArray(j.errorMessages)) parts.push(...j.errorMessages.map(String));
    if (j.errors && typeof j.errors === 'object') parts.push(...Object.values(j.errors).map(String));
    if (typeof j.message === 'string') parts.push(j.message);
    return parts.join('; ');
  } catch {
    return '';
  }
}

export function messageForStatus(status: number, details: string): string {
  const tail = details ? ` (${details})` : '';
  switch (status) {
    case 401:
      return t('Not authorized: check the token (and email for Cloud)') + tail;
    case 403:
      return t('Access denied: the token has no permission for this resource') + tail;
    case 404:
      return t('Not found: check the instance URL and the key');
    default:
      return t('Jira error (HTTP {0})', status) + (details ? ': ' + details : '');
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  /** Строки, которые не должны попасть ни в одно сообщение об ошибке. */
  private readonly secrets: string[];
  private readonly badToken: boolean;

  constructor(opts: HttpOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    const token = opts.token.trim();
    // Пробел/перевод строки/не-ASCII в токене undici отвергает с текстом заголовка в сообщении — ловим заранее.
    this.badToken = !/^[\x21-\x7e]+$/.test(token);
    this.auth = authHeader(opts.kind, token, opts.email?.trim());
    this.secrets = [this.auth, token, this.auth.replace(/^\S+ /, '')].filter((x) => x.length >= 4);
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  url(path: string, query?: Query): string {
    const u = this.baseUrl + (path.startsWith('/') ? path : '/' + path);
    if (!query) return u;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return s ? `${u}?${s}` : u;
  }

  /** GET с разбором JSON. Токен в сообщения и url не попадает. */
  async getJson<T>(path: string, query?: Query): Promise<T> {
    const url = this.url(path, query);
    if (this.badToken) throw new JiraError(0, t('The token contains spaces, line breaks or non-ASCII characters. Copy it again.'), url, 'format');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.auth, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new JiraError(
        0,
        timeout
          ? t('No response from {0}: timed out', this.baseUrl)
          : t('No connection to {0}: {1}', this.baseUrl, this.scrub(networkReason(e))),
        url,
        'network',
      );
    }
    if (res.redirected && res.url && new URL(res.url).origin !== new URL(url).origin) {
      // Authorization на чужой origin fetch не несёт — дальше был бы непонятный 401 или HTML.
      void res.body?.cancel().catch(() => undefined);
      throw new JiraError(0, t('The server redirected to {0}. Use this instance URL.', new URL(res.url).origin), url, 'redirect');
    }
    let text: string;
    const tooBig = () => new JiraError(0, t('The response from {0} is too large', this.baseUrl), url, 'limit');
    try {
      text = await readTextLimited(res, this.maxBytes, tooBig);
    } catch (e) {
      if (e instanceof JiraError) throw e;
      throw new JiraError(0, t('The response from {0} was cut off (timeout or connection lost)', this.baseUrl), url, 'network');
    }
    if (!res.ok) {
      const denied = res.headers.get('x-authentication-denied-reason'); // DC: CAPTCHA после неудачных входов
      const details = [describeBody(text), denied ? `X-Authentication-Denied-Reason: ${denied}` : ''].filter(Boolean).join('; ');
      throw new JiraError(res.status, messageForStatus(res.status, this.scrub(details)), url);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JiraError(0, t('The response is not JSON. Check the instance URL (a context path such as /jira may be needed).'), url, 'format');
    }
  }

  /**
   * POST с JSON-телом (запись: комментарий, переход, ворклог). Отличия от `getJson`:
   * - адрес — только `baseUrl` + путь, и он обязан пройти `isOwnUrl` (иначе `blocked` без запроса);
   * - `redirect: 'manual'`, **любой 3xx — ошибка** `redirect`: тело записи и `Authorization` никуда не пересылаем
   *   (fetch на 302/303 превратил бы POST в GET и молча «успешно» вернул HTML); `login.jsp` — 401;
   * - обрыв или таймаут после отправки — «запись могла сохраниться»: повторять только после проверки журнала.
   * Пустой ответ (204) — `undefined`. В сообщения не попадают ни токен, ни тело запроса.
   */
  async postJson<T>(path: string, body: unknown, query?: Query): Promise<T | undefined> {
    const url = this.url(path, query);
    if (!isOwnUrl(url, this.baseUrl)) throw new JiraError(0, t('The URL does not belong to the instance. Authorized request is blocked.'), '', 'blocked');
    if (this.badToken) throw new JiraError(0, t('The token contains spaces, line breaks or non-ASCII characters. Copy it again.'), url, 'format');
    const saved = maybeSaved();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: this.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      // Соединение не установлено (отказ, DNS, сертификат) — запрос точно не ушёл; иначе (сброс и т. п.) — мог уйти.
      const notSent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(networkReason(e));
      throw new JiraError(
        0,
        timeout
          ? t('No response from {0}: timed out; {1}', this.baseUrl, saved)
          : t('No connection to {0}: {1}', this.baseUrl, this.scrub(networkReason(e))) + (notSent ? '' : `; ${saved}`),
        url,
        'network',
      );
    }
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      void res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location') ?? '';
      if (/\/login\.jsp(?:[?#]|$)/i.test(loc)) throw new JiraError(401, t('Jira redirected to the login page. The token is invalid or lacks write access.'), url);
      throw new JiraError(res.status, t('The server redirected a write request. Request canceled; check the instance URL (https, context path).'), url, 'redirect');
    }
    let text: string;
    // Agentura: ответ на запись тоже с потолком (Jira отдаёт созданный объект — килобайты)
    const tooBig = () => new JiraError(0, t('The response from {0} is too large', this.baseUrl), url, 'limit');
    try {
      text = await readTextLimited(res, Math.min(this.maxBytes, WRITE_MAX_BYTES), tooBig);
    } catch (e) {
      if (e instanceof JiraError) throw e;
      throw new JiraError(0, t('The response from {0} was cut off; {1}', this.baseUrl, saved), url, 'network');
    }
    if (!res.ok) {
      const denied = res.headers.get('x-authentication-denied-reason');
      const details = [describeBody(text), denied ? `X-Authentication-Denied-Reason: ${denied}` : ''].filter(Boolean).join('; ');
      // 502/503/504 — ответил прокси перед Jira, сама Jira запрос могла дописать: та же неоднозначность, что и таймаут.
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new JiraError(res.status, `${messageForStatus(res.status, this.scrub(details))}; ${saved}`, url, 'network');
      }
      throw new JiraError(res.status, messageForStatus(res.status, this.scrub(details)), url);
    }
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      // 2xx, но не JSON: запись, скорее всего, прошла — сообщаем, но не как «не сохранено».
      throw new JiraError(0, t('The write response is not JSON; {0}', saved), url, 'format');
    }
  }

  private scrub(text: string): string {
    return this.secrets.reduce((acc, x) => acc.split(x).join('***'), text);
  }
}

/** undici прячет причину («fetch failed») в `cause`: код ошибки сокета/TLS — самое полезное. */
function networkReason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const msg = typeof cause?.message === 'string' ? cause.message : '';
  const reason = [e.message, code || msg].filter(Boolean).join(': ');
  return /CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code + msg)
    ? t('{0}. The server certificate is not trusted. A corporate CA can be added via NODE_EXTRA_CA_CERTS.', reason)
    : reason;
}
