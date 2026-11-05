/**
 * Поля аккаунта, которые печатает `agent about` / `agent status` (спайк 2026-11-05).
 * Почта и тариф. Модель, ОС и версия CLI сюда не входят. Цены и токенов в выводе нет.
 */
import { execFile } from 'node:child_process';
import type { AccountInfo } from '../types';

const ABOUT_TIMEOUT_MS = 5000;

/** `agent about` / `agent status`. `shell: false`, без лишних флагов. */
export function runCursorCommand(path: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      [...args],
      { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: ABOUT_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** `User Email` → `email`, `Subscription Tier` → `subscriptionType`. Нет строки — поля нет. */
export function accountFromAbout(text: string): AccountInfo {
  const info: AccountInfo = {};
  const email = emailOf(aboutValue(text, 'User Email'));
  const subscriptionType = aboutValue(text, 'Subscription Tier');
  if (email) info.email = email;
  if (subscriptionType) info.subscriptionType = subscriptionType;
  return info;
}

/** `Logged in as …` из `agent status`. Нет адреса — `undefined`. */
export function emailFromStatus(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const email = emailOf(/Logged in as\s+(\S+@\S+)/.exec(line)?.[1]);
    if (email) return email;
  }
  return undefined;
}

function aboutValue(text: string, label: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.startsWith(label)) continue;
    const rest = line.slice(label.length);
    if (!/^[\t ]{2,}/.test(rest)) continue;
    const value = rest.trim();
    if (value) return value;
  }
  return undefined;
}

function emailOf(value: string | undefined): string | undefined {
  if (!value || !/^[^@\s]+@[^@\s]+$/.test(value)) return undefined;
  return value;
}
