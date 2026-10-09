import type { IntegrationsState } from '../../shared/integrations';
import type { JiraSources } from './source';

type SourcesLike = Pick<JiraSources, 'jiraffeStatus' | 'jiraffeInstances' | 'ownInstances' | 'activeKind' | 'canWrite'>;

/** Данные страницы «Интеграции»: версия Jiraffe — из его `packageJSON` (`jiraffeStatus()` её не отдаёт). */
export function integrationsState(sources: SourcesLike, jiraffeVersion?: unknown): IntegrationsState {
  const { state } = sources.jiraffeStatus();
  const active = sources.activeKind();
  return {
    jiraffe: {
      state,
      ...(state !== 'absent' && typeof jiraffeVersion === 'string' ? { version: jiraffeVersion.slice(0, 40) } : {}),
      instances: state === 'ready' ? sources.jiraffeInstances() : [],
    },
    own: sources.ownInstances(),
    ...(active ? { active } : {}),
    writes: sources.canWrite(),
  };
}
