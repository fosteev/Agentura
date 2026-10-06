import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listAgyModels, parseModels } from './models';

const out = readFileSync(new URL('../../../test/fixtures/antigravity/models.txt', import.meta.url), 'utf8');

describe('agy models', () => {
  it('разбирает вывод `agy models`: id и название, строка «Fetching…» пропущена', () => {
    const models = parseModels(out);
    expect(models).toHaveLength(14);
    expect(models[2]).toEqual({ value: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)', supportsEffort: false });
    expect(models.map((m) => m.value)).toContain('claude-opus-4-6-thinking');
  });

  it('мусор и пустой вывод — пустой список; listAgyModels берёт путь', async () => {
    expect(parseModels('Fetching available models...\n')).toEqual([]);
    expect(parseModels('')).toEqual([]);
    expect(await listAgyModels('/x/agy', async (p) => `${p}\t`)).toEqual([]);
    expect(await listAgyModels('/x/agy', async () => out)).toHaveLength(14);
  });
});
