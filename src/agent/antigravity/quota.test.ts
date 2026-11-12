import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanAgyUsageError, isAgyAuthError, parseAgyUsage, runAgyUsage } from './quota';

const REAL_OLD =
  'Gemini Models\tWeekly Limit Remaining\t26%\t2026-10-12T16:21:42Z\n' +
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-12T22:43:53Z\n';

const REAL_153 =
  'Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-12T16:21:42Z\n' +
  'Gemini Models\tFive Hour Limit Remaining\t97%\t2026-10-12T16:21:42Z\n' +
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-12T22:43:53Z\n' +
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-12T22:43:53Z\n' +
  'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t66%\t2026-10-12T16:21:42Z\n';

describe('parseAgyUsage', () => {
  it('разбирает 5-оконный вывод agy 1.5.3 с разделением 5ч/7д и Argon', () => {
    expect(parseAgyUsage(REAL_153)).toEqual([
      { label: 'Gemini 7д', name: 'Gemini Models', remaining: 99, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' },
      { label: 'Gemini 5ч', name: 'Gemini Models', remaining: 97, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'fiveHour' },
      { label: 'Claude/GPT 7д', name: 'Claude and GPT models', remaining: 100, resetsAt: Date.parse('2026-10-12T22:43:53Z'), window: 'weekly' },
      { label: 'Claude/GPT 5ч', name: 'Claude and GPT models', remaining: 100, resetsAt: Date.parse('2026-10-12T22:43:53Z'), window: 'fiveHour' },
      { label: 'Gemini 4 Argon 7д', name: 'Gemini 4 Argon', remaining: 66, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' },
    ]);
  });

  it('сохраняет обратную совместимость со старым 2-строчным выводом', () => {
    expect(parseAgyUsage(REAL_OLD)).toEqual([
      { label: 'Gemini 7д', name: 'Gemini Models', remaining: 26, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' },
      { label: 'Claude/GPT 7д', name: 'Claude and GPT models', remaining: 100, resetsAt: Date.parse('2026-10-12T22:43:53Z'), window: 'weekly' },
    ]);
  });

  it('мягкий: CRLF, нет даты, процент не в третьем поле, дробный процент', () => {
    const rows = parseAgyUsage('Gemini Models\r\nPro Models\tWeekly Limit\t12.6 %\r\nOther\tLimit\t7%\r\n');
    expect(rows.map((r) => [r.label, r.remaining, r.window])).toEqual([['Pro Models 7д', 13, 'weekly'], ['Other', 7, undefined]]);
    expect(parseAgyUsage('Other\tLimit\tx\t3%\n')[0]?.remaining).toBe(3);
    expect(parseAgyUsage('Other\tLimit\t12.6%\n')[0]?.remaining).toBe(13);
  });

  it('мусор, пустой вывод и предупреждения — пустой список', () => {
    expect(parseAgyUsage('')).toEqual([]);
    expect(parseAgyUsage('Error: not logged in\nrun agy to sign in\n')).toEqual([]);
  });

  it('запятая в дроби, поля через пробелы, колонка «used» переворачивается в остаток', () => {
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Remaining\t12,4%\n')[0]?.remaining).toBe(12);
    const spaced = parseAgyUsage('Gemini Models    Weekly Limit Remaining    26%    2026-10-12T16:21:42Z\n')[0];
    expect(spaced).toMatchObject({ label: 'Gemini 7д', remaining: 26, resetsAt: Date.parse('2026-10-12T16:21:42Z'), window: 'weekly' });
    expect(parseAgyUsage('Gemini Models\tWeekly Limit Used\t74%\n')[0]?.remaining).toBe(26);
  });

  it('шум с процентом (прогресс, лог) без подписи про лимит и без даты — не квота', () => {
    expect(parseAgyUsage('Downloading update    45%\nfetch\t3%\n')).toEqual([]);
  });

  it('процент зажат в 0…100', () => {
    expect(parseAgyUsage('Gemini\tWeekly Limit Remaining\t140%\n')[0]?.remaining).toBe(100);
  });

  it('очищает \\r-спиннер и оставляет именные пулы Gemini (Argon, Carbon) отдельными семействами', () => {
    const out156 =
      '\r⠋ Fetching usage...\r\x1b[2KGemini Models\tWeekly Limit Remaining\t88%\t2026-11-18T12:00:00Z\r\n' +
      '\r⠙ Fetching usage...\rGemini 4 Argon\tGemini 4 Argon Weekly Limit\t65%\t2026-11-18T12:00:00Z\r\n' +
      'Gemini 4 Carbon\tGemini 4 Carbon Weekly Limit\t42%\t2026-11-18T12:00:00Z\n';
    expect(parseAgyUsage(out156)).toEqual([
      { label: 'Gemini 7д', name: 'Gemini Models', remaining: 88, resetsAt: Date.parse('2026-11-18T12:00:00Z'), window: 'weekly' },
      { label: 'Gemini 4 Argon 7д', name: 'Gemini 4 Argon', remaining: 65, resetsAt: Date.parse('2026-11-18T12:00:00Z'), window: 'weekly' },
      { label: 'Gemini 4 Carbon 7д', name: 'Gemini 4 Carbon', remaining: 42, resetsAt: Date.parse('2026-11-18T12:00:00Z'), window: 'weekly' },
    ]);
  });
});

describe('runAgyUsage & isAgyAuthError', () => {
  it('захватывает stderr в runAgyUsage, очищая спиннер, ANSI и префикс error:', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'agy-usage-test-'));
    try {
      const script = join(dir, 'fake-agy.sh');
      await writeFile(
        script,
        '#!/bin/sh\nprintf "\\r⠋ Fetching...\\r\\033[31merror: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.\\033[0m\\n" >&2\nexit 1\n',
        'utf8',
      );
      await chmod(script, 0o755);
      await expect(runAgyUsage(script)).rejects.toThrow(
        'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleanAgyUsageError берёт stdout или сообщение ошибки при пустом stderr', () => {
    expect(cleanAgyUsageError(new Error('Command failed: agy -p /usage'), 'Error: not logged in\n', '').message).toBe(
      'not logged in',
    );
    expect(cleanAgyUsageError(new Error('connect ECONNRESET 142.250.74.10:443'), '', '').message).toBe(
      'connect ECONNRESET 142.250.74.10:443',
    );
  });

  it('isAgyAuthError отличает реальный разлогин от регионального отказа Eligibility check failed и сети', () => {
    expect(isAgyAuthError(new Error('Error: not logged in\nrun agy to sign in'))).toBe(true);
    expect(isAgyAuthError('unauthenticated: login required')).toBe(true);
    expect(isAgyAuthError(new Error('oauth2: invalid_grant'))).toBe(true);
    expect(isAgyAuthError(new Error('missing credentials'))).toBe(true);

    expect(
      isAgyAuthError(
        new Error(
          'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.',
        ),
      ),
    ).toBe(false);
    expect(
      isAgyAuthError(
        new Error('Post "https://oauth2.googleapis.com/oauth/token": dial tcp 142.250.74.95:443: i/o timeout'),
      ),
    ).toBe(false);
    expect(
      isAgyAuthError(
        new Error('Post "https://example.com/oauth/token": read tcp 10.0.0.2:54321->142.250.74.95:443: connection reset by peer'),
      ),
    ).toBe(false);
    expect(
      isAgyAuthError(new Error('Post "https://oauth2.googleapis.com/token": tls handshake timeout')),
    ).toBe(false);
    expect(isAgyAuthError(new Error('Get "https://auth.example.com/login": context deadline exceeded'))).toBe(false);
    expect(isAgyAuthError(new Error('Post "https://oauth2.googleapis.com/token": unexpected EOF'))).toBe(false);
    expect(isAgyAuthError(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'))).toBe(false);
    expect(isAgyAuthError(new Error('getaddrinfo EAI_AGAIN oauth2.googleapis.com'))).toBe(false);
    expect(isAgyAuthError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(false);
    expect(isAgyAuthError(new Error('agy -p /usage: no answer'))).toBe(false);
    expect(isAgyAuthError(new Error('connect ECONNRESET'))).toBe(false);
    expect(isAgyAuthError('')).toBe(false);
  });
});
