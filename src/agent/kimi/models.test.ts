import { describe, expect, it } from 'vitest';
import { KimiCatalogError, loadKimiModels, parseKimiModels } from './models';

describe('Kimi provider catalog', () => {
  it('uses only models and keeps real per-model effort levels', () => {
    const models = parseKimiModels({
      providers: { managed: { apiKey: 'must-not-leak' } },
      models: {
        'kimi-code/k3.1-pro': { displayName: 'K3.1 Pro', supportEfforts: ['low', 'high', 'max'] },
        'kimi-code/boolean': { displayName: 'Boolean thinking', supportEfforts: ['on'] },
      },
    });
    expect(models).toEqual([
      { value: 'kimi-code/k3.1-pro', displayName: 'K3.1 Pro', supportsEffort: true, effortLevels: ['low', 'high', 'max'] },
      { value: 'kimi-code/boolean', displayName: 'Boolean thinking', supportsEffort: false },
    ]);
    expect(JSON.stringify(models)).not.toContain('must-not-leak');
    expect(JSON.stringify(models)).not.toContain('providers');
  });

  it('never exposes raw provider output in catalog errors', async () => {
    const secret = 'providers.apiKey=must-not-leak';
    const error = await loadKimiModels('/x/kimi', async () => { throw new Error(secret); }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KimiCatalogError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain('kimi provider list --json');
  });

  it('distinguishes an explicit signed-out CLI response without an ACP session', async () => {
    const error = await loadKimiModels('/x/kimi', async () => { throw new Error('Not logged in. Login required.'); }).catch((e: unknown) => e);
    expect(error).toMatchObject({ signedOut: true });
  });
});
