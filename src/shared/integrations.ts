/** Данные страницы настроек «Интеграции» (roadmap 19, этап 6): состояние Jiraffe и своих подключений Jira. */

export type JiraffeStateName = 'absent' | 'no-api' | 'ready' | 'inactive';

export interface IntegrationsInstance {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'dc' | 'cloud';
}

export interface IntegrationsState {
  jiraffe: {
    state: JiraffeStateName;
    /** Версия установленного расширения (`packageJSON.version`); нет расширения — нет поля. */
    version?: string;
    /** Инстансы Jiraffe в наборе воркспейса (только при `ready`). */
    instances: IntegrationsInstance[];
  };
  /** Свои подключения воркспейса. */
  own: IntegrationsInstance[];
  /** Какой источник работает сейчас (по `jira.source` и наличию); нет — задач нет. */
  active?: 'jiraffe' | 'own';
}
