/** Стор вкладки настроек: значения из хоста, черновики полей, ошибки, итог «проверить». */
import { signal } from '@preact/signals';
import type { ToWebview } from '../protocol';
import type { EngineCheck, SettingKey, SettingsValues } from '../settings';
import { send } from './vscode';

export const settingsValues = signal<SettingsValues | undefined>(undefined);
export const overridden = signal<SettingKey[]>([]);
/** Текст ошибки у поля: ошибка проверки (до отправки) или отказ хоста. */
export const errors = signal<Partial<Record<SettingKey, string>>>({});
export const engineCheck = signal<{ pending: boolean; result?: EngineCheck }>({ pending: false });
/** То же для пути к Codex: проверки двух движков не перебивают друг друга. */
export const codexCheck = signal<{ pending: boolean; result?: EngineCheck }>({ pending: false });

export function handleSettingsMessage(m: ToWebview): void {
  switch (m.type) {
    case 'settings.state':
      settingsValues.value = m.values;
      overridden.value = m.overridden;
      break;
    case 'settings.error':
      errors.value = { ...errors.value, [m.key]: m.message };
      break;
    case 'settings.engine':
      (m.engine === 'codex' ? codexCheck : engineCheck).value = { pending: false, result: m.result };
      break;
    default:
      break;
  }
}

export function setError(key: SettingKey, message: string | undefined): void {
  const next = { ...errors.value };
  if (message === undefined) delete next[key];
  else next[key] = message;
  errors.value = next;
}

/** Записать настройку; прежняя ошибка поля снимается, новая придёт от хоста. */
export function commit(key: SettingKey, value: unknown): void {
  setError(key, undefined);
  send({ type: 'settings.set', key, value });
}

export function checkEngine(path: string, engine: 'claude' | 'codex' = 'claude'): void {
  (engine === 'codex' ? codexCheck : engineCheck).value = { pending: true };
  send(engine === 'codex' ? { type: 'settings.checkEngine', path, engine } : { type: 'settings.checkEngine', path });
}

/** «Добавить из Google Fonts…»: хост открывает QuickPick (`kind` — интерфейсные, моноширинные или все — для панелей). */
export function addFont(kind: 'ui' | 'code' | 'panels'): void {
  send({ type: 'fonts.add', kind });
}

/** ✕ у скачанного шрифта. */
export function removeFont(family: string): void {
  send({ type: 'fonts.remove', family });
}

export function reveal(target: 'ui' | 'json'): void {
  send({ type: 'settings.reveal', target });
}
