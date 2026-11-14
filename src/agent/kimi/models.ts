import { execFile } from 'node:child_process';
import type { EffortLevel, ModelOption } from '../types';

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CATALOG_ERROR = 'Kimi model catalog is unavailable (kimi provider list --json).';

export class KimiCatalogError extends Error {
  constructor(readonly signedOut: boolean) {
    super(CATALOG_ERROR);
    this.name = 'KimiCatalogError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Только безопасный блок models: providers и их apiKey не возвращаются и не попадают в ошибки. */
export function parseKimiModels(value: unknown): ModelOption[] {
  const models = record(record(value)?.models);
  if (!models) throw new KimiCatalogError(false);
  const out: ModelOption[] = [];
  for (const [value, raw] of Object.entries(models)) {
    if (!value) continue;
    const model = record(raw);
    if (!model) continue;
    const displayName = typeof model.displayName === 'string' && model.displayName.trim()
      ? model.displayName.trim()
      : value;
    const levels = Array.isArray(model.supportEfforts)
      ? model.supportEfforts.filter((v): v is EffortLevel => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v))
      : [];
    out.push({
      value,
      displayName,
      supportsEffort: levels.length > 0,
      ...(levels.length ? { effortLevels: levels } : {}),
    });
  }
  return out;
}

function signedOut(text: string): boolean {
  return /(?:not\s+(?:logged|signed)\s+in|not\s+authenticated|login\s+required|sign[ -]?in\s+required|unauthorized|http\s*401)/i.test(text);
}

function runCatalog(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['provider', 'list', '--json'], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new KimiCatalogError(signedOut(`${error.message}\n${stderr}`)));
      else resolve(stdout);
    });
  });
}

/** Каталог без ACP session: один короткий CLI process, без записи конфигурации и без сырого вывода в лог. */
export async function loadKimiModels(
  executable: string,
  run: (path: string) => Promise<string> = runCatalog,
): Promise<ModelOption[]> {
  try {
    return parseKimiModels(JSON.parse(await run(executable)));
  } catch (error) {
    if (error instanceof KimiCatalogError) throw error;
    throw new KimiCatalogError(signedOut(error instanceof Error ? error.message : String(error)));
  }
}
