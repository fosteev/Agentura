// Скопировано из fosteev/jiraffe 0.7.0 test/http.test.ts (без canonicalBaseUrl — он в extension/taskLink.ts);
// этап 8: `isOwnUrl` — из test/attachments.test.ts, `postJson` — из test/worklog.test.ts Jiraffe.
import { describe, expect, it } from 'vitest';
import { HttpClient, JiraError, authHeader, isOwnUrl, normalizeBaseUrl } from './http';

function mockFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const fail = (p: Promise<unknown>): Promise<JiraError> =>
  p.then(() => { throw new Error('ожидалась ошибка'); }, (e: unknown) => e as JiraError);

describe('authHeader', () => {
  it('DC — Bearer', () => expect(authHeader('dc', 'tok')).toBe('Bearer tok'));
  it('Cloud — Basic email:token', () => {
    expect(authHeader('cloud', 'tok', 'u@example.com')).toBe('Basic ' + Buffer.from('u@example.com:tok').toString('base64'));
  });
});

describe('HttpClient', () => {
  it('шлёт заголовки DC и учитывает context path', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = new HttpClient({ baseUrl: 'https://host.example/jira/', kind: 'dc', token: 'tok', fetchImpl: mockFetch(200, { ok: 1 }, calls) });
    expect(await http.getJson('/rest/api/2/myself', { a: 1, b: undefined })).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe('https://host.example/jira/rest/api/2/myself?a=1');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('шлёт Basic для Cloud', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = new HttpClient({ baseUrl: 'https://x.example', kind: 'cloud', token: 't', email: 'a@b.c', fetchImpl: mockFetch(200, {}, calls) });
    await http.getJson('/rest/api/2/myself');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it.each([
    [401, /Not authorized/],
    [403, /Access denied/],
    [404, /Not found/],
    [500, /HTTP 500\): boom/],
  ])('статус %i → JiraError с локализованным сообщением', async (status, re) => {
    const http = new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SECRET', fetchImpl: mockFetch(status, { errorMessages: ['boom'] }) });
    const err = await fail(http.getJson('/p'));
    expect(err).toBeInstanceOf(JiraError);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(re);
    expect(err.url).toBe('https://x.example/p');
    expect(err.message + err.url).not.toContain('SECRET');
  });

  it('сетевая ошибка → status 0', async () => {
    const f = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f }).getJson('/p'));
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/No connection/);
  });

  it('не-JSON при 200 → понятная ошибка', async () => {
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: mockFetch(200, '<html>') }).getJson('/p'));
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/JSON/);
  });

  it('normalizeBaseUrl убирает хвостовые слэши', () => {
    expect(normalizeBaseUrl(' https://h/jira// ')).toBe('https://h/jira');
  });

  it('обрыв тела ответа → JiraError network', async () => {
    const f = (async () => ({ ok: true, status: 200, text: async () => { throw new DOMException('aborted', 'TimeoutError'); } })) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f }).getJson('/p'));
    expect(err).toBeInstanceOf(JiraError);
    expect(err.code).toBe('network');
  });
});

describe('HttpClient: безопасность и диагностика', () => {
  type Fake = { status?: number; ok?: boolean; headers?: Headers; redirected?: boolean; url?: string; body?: string };
  const fake = ({ body, ...r }: Fake) =>
    (async () => ({ ok: (r.status ?? 200) < 300, status: 200, headers: new Headers(), redirected: false, url: '', text: async () => body ?? '{}', ...r })) as unknown as typeof fetch;

  it('токен с \\r\\n обрезается; с пробелом внутри — понятная ошибка без токена', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SECRET123\r\n', fetchImpl: mockFetch(200, {}, calls) }).getJson('/p');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer SECRET123');
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SEC RET123', fetchImpl: mockFetch(200, {}) }).getJson('/p'));
    expect(err.message).toMatch(/The token contains/);
    expect(err.message).not.toContain('RET123');
  });

  it('токен вычищается из текста сетевой ошибки', async () => {
    const f = (async () => { throw new TypeError('Headers.append: "Bearer SECRET123" is an invalid header value'); }) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 'SECRET123', fetchImpl: f }).getJson('/p'));
    expect(err.message).not.toContain('SECRET123');
  });

  it('cause сетевой ошибки попадает в сообщение, на TLS — подсказка про CA', async () => {
    const f = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }); }) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f }).getJson('/p'));
    expect(err.message).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT.*NODE_EXTRA_CA_CERTS/);
  });

  it('редирект на другой origin → JiraError redirect; на тот же — обычная обработка', async () => {
    const cross = await fail(new HttpClient({ baseUrl: 'http://x.example', kind: 'dc', token: 't', fetchImpl: fake({ redirected: true, url: 'https://x.example/p' }) }).getJson('/p'));
    expect(cross.code).toBe('redirect');
    expect(cross.message).toContain('https://x.example');
    const same = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: fake({ redirected: true, url: 'https://x.example/login.jsp', body: '<html>' }) }).getJson('/p'));
    expect(same.code).toBe('format');
  });

  it('401: errorMessages и X-Authentication-Denied-Reason в сообщении', async () => {
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't',
      fetchImpl: fake({ status: 401, ok: false, headers: new Headers({ 'X-Authentication-Denied-Reason': 'CAPTCHA_CHALLENGE' }), body: '{"errorMessages":["nope"]}' }) }).getJson('/p'));
    expect(err.message).toMatch(/Not authorized.*nope.*CAPTCHA_CHALLENGE/);
  });
});


describe('перевод сообщений (Agentura)', () => {
  it('на русском — перевод, неизвестное сообщение — как есть', async () => {
    const { setJiraLang, t } = await import('./i18n');
    setJiraLang('ru');
    try {
      expect(t('Not found: check the instance URL and the key')).toMatch(/Не найдено/);
      expect(t('No connection to {0}: {1}', 'h', 'x')).toBe('Нет соединения с h: x');
      expect(t('Unknown {0}', 1)).toBe('Unknown 1');
    } finally {
      setJiraLang('en');
    }
  });
});

describe('HttpClient: потолок ответа (Agentura)', () => {
  it('тело больше maxBytes — ошибка limit, без разбора; в пределах — разбирается', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(2_000) });
    const f = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f, maxBytes: 1_000 }).getJson('/p'));
    expect(err).toBeInstanceOf(JiraError);
    expect(err.code).toBe('limit');
    const ok = await new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f, maxBytes: 10_000 }).getJson<{ text: string }>('/p');
    expect(ok.text).toHaveLength(2_000);
  });

  it('Content-Length сверх потолка — отказ до чтения', async () => {
    const f = (async () => new Response('{}', { status: 200, headers: { 'content-length': '999999999' } })) as unknown as typeof fetch;
    const err = await fail(new HttpClient({ baseUrl: 'https://x.example', kind: 'dc', token: 't', fetchImpl: f, maxBytes: 1_000 }).getJson('/p'));
    expect(err.code).toBe('limit');
  });
});

const BASE = 'https://jira.example.test/jira';
const TOKEN = 'secret-token-123';

describe('isOwnUrl', () => {
  it('тот же origin и context path', () => {
    expect(isOwnUrl(`${BASE}/secure/attachment/1/a.png`, BASE)).toBe(true);
    expect(isOwnUrl('https://jira.example.test/secure/attachment/1/a.png', BASE)).toBe(false); // вне /jira
    expect(isOwnUrl('https://jira.example.test/jiraX/a.png', BASE)).toBe(false);
    expect(isOwnUrl('http://jira.example.test/jira/a.png', BASE)).toBe(false); // другая схема — другой origin
    expect(isOwnUrl('https://evil.test/jira/a.png', BASE)).toBe(false);
    expect(isOwnUrl('https://jira.example.test.evil.test/jira/a.png', BASE)).toBe(false);
    expect(isOwnUrl('https://u:p@jira.example.test/jira/a.png', BASE)).toBe(false);
    expect(isOwnUrl('javascript:alert(1)', BASE)).toBe(false);
    expect(isOwnUrl('https://ex.atlassian.net/rest/api/2/attachment/content/1', 'https://ex.atlassian.net')).toBe(true);
  });
});

describe('HttpClient.postJson', () => {
  const http = (route: (url: string, init: RequestInit) => Response | Promise<Response>) =>
    new HttpClient({ baseUrl: BASE, kind: 'dc', token: TOKEN, fetchImpl: ((u: string, i: RequestInit) => route(u, i)) as unknown as typeof fetch });
  it('3xx — ошибка redirect, по Location не идём; login.jsp — 401', async () => {
    let n = 0;
    let init: RequestInit | undefined;
    const h = http((_, i) => {
      n++;
      init = i;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/x' } });
    });
    await expect(h.postJson('/rest/x', {})).rejects.toMatchObject({ code: 'redirect' });
    expect(n).toBe(1);
    expect(init?.redirect).toBe('manual');
    const h2 = http(() => new Response(null, { status: 302, headers: { location: '/jira/login.jsp?os_destination=x' } }));
    await expect(h2.postJson('/rest/x', {})).rejects.toMatchObject({ status: 401 });
  });
  it('таймаут — «запись могла сохраниться», токена в тексте нет', async () => {
    const h = http(() => {
      const e = new Error(`boom ${TOKEN}`);
      e.name = 'TimeoutError';
      throw e;
    });
    const err = await fail(h.postJson('/rest/x', { a: 1 }));
    expect(err).toBeInstanceOf(JiraError);
    expect(err.message).toMatch(/may have been saved/);
    expect(err.message).not.toContain(TOKEN);
    const h2 = http(() => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET', message: TOKEN } });
    });
    const e2 = await fail(h2.postJson('/rest/x', {}));
    expect(e2.message).not.toContain(TOKEN);
    expect(e2.message).toMatch(/may have been saved/); // сброс соединения — запрос мог уйти
    const h3 = http(() => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const e3 = await fail(h3.postJson('/rest/x', {}));
    expect(e3.message).not.toMatch(/may have been saved/); // соединения не было — запись точно не ушла
  });
  it('502/503/504 прокси — «запись могла сохраниться» (code network); 500 — обычная ошибка', async () => {
    const e = await fail(http(() => new Response('<html>Gateway Timeout</html>', { status: 504 })).postJson('/rest/x', {}));
    expect(e).toMatchObject({ status: 504, code: 'network' });
    expect(e.message).toMatch(/may have been saved/);
    const e2 = await fail(http(() => new Response('{"errorMessages":["boom"]}', { status: 500 })).postJson('/rest/x', {}));
    expect(e2.code).toBe('http');
    expect(e2.message).not.toMatch(/may have been saved/);
  });
  it('400 с errors — текст в сообщении; 204 — undefined; 2xx не-JSON — format', async () => {
    const h = http(() => new Response(JSON.stringify({ errors: { comment: 'Comment body can not be empty!' } }), { status: 400 }));
    await expect(h.postJson('/rest/x', {})).rejects.toThrow(/can not be empty/);
    await expect(http(() => new Response(null, { status: 204 })).postJson('/rest/x', {})).resolves.toBeUndefined();
    await expect(http(() => new Response('<html/>', { status: 201 })).postJson('/rest/x', {})).rejects.toMatchObject({ code: 'format' });
  });
  it('адрес вне инстанса не отправляется; свой — с телом JSON и авторизацией', async () => {
    let n = 0;
    const h = http(() => {
      n++;
      return new Response('{}');
    });
    await expect(h.postJson('/../../evil', {})).rejects.toMatchObject({ code: 'blocked' }); // путь вышел из context path
    expect(n).toBe(0);
    let sent = '';
    let init: RequestInit | undefined;
    const h2 = http((u, i) => {
      sent = u;
      init = i;
      return new Response('{"id":"7"}', { status: 201 });
    });
    await expect(h2.postJson('/rest/api/2/issue/ABC-1/worklog', { a: 1 }, { adjustEstimate: 'leave' })).resolves.toEqual({ id: '7' });
    expect(sent).toBe('https://jira.example.test/jira/rest/api/2/issue/ABC-1/worklog?adjustEstimate=leave');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
