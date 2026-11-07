import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listAgyModels, loadAntigravityCatalog, parseAgyModels, parseModels } from './models';

const out = readFileSync(new URL('../../../test/fixtures/antigravity/models.txt', import.meta.url), 'utf8');

describe('agy models', () => {
  it('разбирает вывод `agy models`: id и название, строка «Fetching…» пропущена', () => {
    const models = parseModels(out);
    expect(models).toHaveLength(14);
    expect(models[2]).toEqual({ value: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)', supportsEffort: false });
    expect(models.map((m) => m.value)).toContain('claude-opus-4-6-thinking');
  });

  it('parseAgyModels схлопывает суффиксы effort в базовые модели', () => {
    const catalog = parseAgyModels(out);
    const flash = catalog.find((m) => m.value === 'gemini-3.8-flash');
    expect(flash).toEqual({
      value: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      supportsEffort: true,
      effortLevels: ['high', 'medium', 'low'],
    });
    const gptOss = catalog.find((m) => m.value === 'gpt-oss-120b-medium');
    expect(gptOss).toEqual({
      value: 'gpt-oss-120b-medium',
      displayName: 'GPT-OSS 120B (Medium)',
      supportsEffort: false,
    });
  });

  it('мусор и пустой вывод — пустой список; listAgyModels берёт путь', async () => {
    expect(parseModels('Fetching available models...\n')).toEqual([]);
    expect(parseModels('')).toEqual([]);
    expect(await listAgyModels('/x/agy', async (p) => `${p}\t`)).toEqual([]);
    expect(await listAgyModels('/x/agy', async () => out)).toHaveLength(14);
    expect(await loadAntigravityCatalog('/x/agy', async () => out)).toHaveLength(7);
  });
});
