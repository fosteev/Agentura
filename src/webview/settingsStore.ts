/** Стор вкладки настроек: значения из хоста, черновики полей, ошибки, итог «проверить». */
import { signal } from '@preact/signals';
import type { ToWebview } from '../protocol';
import type { IntegrationsState } from '../shared/integrations';
import type { EngineCheck, SettingKey, SettingsValues } from '../settings';
import { send } from './vscode';

export const settingsValues = signal<SettingsValues | undefined>(undefined);
/** Jiraffe и свои подключения Jira (страница «Интеграции»); до ответа хоста — `undefined`. */
export const integrations = signal<IntegrationsState | undefined>(undefined);
export const overridden = signal<SettingKey[]>([]);
/** Текст ошибки у поля: ошибка проверки (до отправки) или отказ хоста. */
export const errors = signal<Partial<Record<SettingKey, string>>>({});
export const engineCheck = signal<{ pending: boolean; result?: EngineCheck }>({ pending: false });
/** То же для пути к Codex и к agy: проверки движков не перебивают друг друга. */
export const codexCheck = signal<{ pending: boolean; result?: EngineCheck }>({ pending: false });
export const agyCheck = signal<{ pending: boolean; result?: EngineCheck }>({ pending: false });

function checkSignal(engine: 'claude' | 'codex' | 'antigravity') {
  return engine === 'codex' ? codexCheck : engine === 'antigravity' ? agyCheck : engineCheck;
}

export function handleSettingsMessage(m: ToWebview): void {
  switch (m.type) {
    case 'settings.state':
      settingsValues.value = m.values;
      overridden.value = m.overridden;
      break;
    case 'integrations.state':
      integrations.value = m.state;
      break;
    case 'settings.error':
      errors.value = { ...errors.value, [m.key]: m.message };
      break;
    case 'settings.engine':
      checkSignal(m.engine ?? 'claude').value = { pending: false, result: m.result };
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

export function checkEngine(path: string, engine: 'claude' | 'codex' | 'antigravity' = 'claude'): void {
  checkSignal(engine).value = { pending: true };
  send(engine === 'claude' ? { type: 'settings.checkEngine', path } : { type: 'settings.checkEngine', path, engine });
}

/** «Добавить из Google Fonts…»: хост открывает QuickPick (`kind` — интерфейсные, моноширинные или все — для панелей). */
export function addFont(kind: 'ui' | 'code' | 'panels'): void {
  send({ type: 'fonts.add', kind });
}

/** ✕ у скачанного шрифта. */
export function removeFont(family: string): void {
  send({ type: 'fonts.remove', family });
}

/** Страница «Интеграции»: «подключить», «проверить», «удалить» — команды этапа 2; «поставить» — карточка Jiraffe в Extensions. */
export const integrationsAction = {
  connect: () => send({ type: 'integrations.connect' }),
  test: (instanceId: string) => send({ type: 'integrations.test', instanceId }),
  disconnect: (instanceId: string) => send({ type: 'integrations.disconnect', instanceId }),
  installJiraffe: () => send({ type: 'integrations.installJiraffe' }),
};

export function reveal(target: 'ui' | 'json'): void {
  send({ type: 'settings.reveal', target });
}
