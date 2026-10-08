import { describe, expect, it } from 'vitest';
import { integrationsState } from './integrationsState';

const inst = (id: string) => ({ id, name: id, baseUrl: `https://${id}.x`, kind: 'dc' as const });
const src = (state: 'absent' | 'no-api' | 'ready' | 'inactive', active?: 'jiraffe' | 'own') => ({
  jiraffeStatus: () => ({ state, instances: 1 }),
  jiraffeInstances: () => [inst('jf')],
  ownInstances: () => [inst('own')],
  activeKind: () => active,
});

describe('integrationsState', () => {
  it('ready: инстансы Jiraffe и версия; свои подключения', () => {
    expect(integrationsState(src('ready', 'jiraffe'), '0.8.0')).toEqual({
      jiraffe: { state: 'ready', version: '0.8.0', instances: [inst('jf')] },
      own: [inst('own')],
      active: 'jiraffe',
    });
  });
  it('не ready — инстансов Jiraffe нет; absent — без версии; нетекстовая версия отбрасывается', () => {
    expect(integrationsState(src('inactive', 'own'), '0.8.0').jiraffe).toEqual({ state: 'inactive', version: '0.8.0', instances: [] });
    expect(integrationsState(src('absent'), '0.8.0').jiraffe).toEqual({ state: 'absent', instances: [] });
    expect(integrationsState(src('no-api'), 7).jiraffe).toEqual({ state: 'no-api', instances: [] });
    expect(integrationsState(src('absent')).active).toBeUndefined();
  });
});
