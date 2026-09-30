/**
 * Vendored-выжимка `apps/desktop/src/main/oauth.ts` Agentmeter: чтение токена Claude Code
 * (`readToken`, `defaultKeychain`). Опрос, журнал и статус для экрана настроек не перенесены —
 * их место занимает `src/data/limits.ts`. Правки против источника (ORIGIN.md): `OauthHost` без
 * `fetch`, тип источника токена — свой литерал вместо `UsageApiStatus['credentials']` из
 * `@agentmeter/ipc`, импорт `parseCredentials` — из vendored `limits/oauth.ts`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCredentials } from '../limits/oauth.ts'

/** Откуда взялся токен (в источнике — `UsageApiStatus['credentials']`). */
export type TokenSource = 'file' | 'keychain' | 'missing'

/** Что модулю нужно от машины: пути, а не `app`. */
export interface OauthHost {
  /** Каталог настроек Claude Code: там `.credentials.json`. */
  claudeHome: string
  platform: NodeJS.Platform
  /**
   * Чем читать Keychain. Тоже параметром: на машине без Keychain (Windows,
   * Linux, CI) ветка иначе не проверялась бы вовсе.
   */
  keychain?: () => string | undefined
}

/**
 * Где лежит токен и какой он.
 *
 * Порядок — файл, потом Keychain, и это не алфавит: файл `.credentials.json`
 * пишет `claude login` на Linux и в старых сборках, Keychain — текущий macOS.
 * На замеренной машине файла нет вовсе, всё в Keychain, — то есть вторая ветка
 * основная, а не запасная.
 *
 * Токен возвращается вместе с тем, откуда он взялся: экран настроек показывает
 * источник, и «токен не найден» отличается от «токен найден, но отвергнут»
 * ровно этим полем.
 */
export function readToken(host: OauthHost): { token?: string; from: TokenSource } {
  try {
    const token = parseCredentials(readFileSync(join(host.claudeHome, '.credentials.json'), 'utf8'))
    if (token !== undefined) return { token, from: 'file' }
  } catch {
    // Файла нет — обычное дело на macOS, там всё в Keychain. Не ошибка.
  }

  const raw = (host.keychain ?? defaultKeychain(host.platform))()
  if (raw === undefined) return { from: 'missing' }
  const token = parseCredentials(raw)
  return token === undefined ? { from: 'missing' } : { token, from: 'keychain' }
}

/**
 * Чтение Keychain через `security`, а не через нативный модуль.
 *
 * Нативный биндинг к Security.framework пришлось бы собирать под обе
 * архитектуры и пересобирать под каждую версию Electron — ради одной строки,
 * которую системная утилита отдаёт сама. Вывод — тот же JSON, что в
 * `.credentials.json`.
 */
export function defaultKeychain(platform: NodeJS.Platform): () => string | undefined {
  if (platform !== 'darwin') return () => undefined
  return () => {
    try {
      return execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      // Записи нет, доступ не дан, диалог отклонён — все три случая означают
      // одно: токена у нас нет. Разбирать их по коду возврата нечем, `security`
      // возвращает 44 и 128 вперемешку.
      return undefined
    }
  }
}
