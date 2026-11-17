import { execFile } from 'node:child_process';
import type { ModelOption } from '../types';

/**
 * Разбирает вывод `gemini --list-models` вида:
 *
 *   auto (Auto)
 *     Description:   ...
 *     Context limit: ...
 *
 *   gemini-2.5-pro (gemini-2.5-pro)
 *     Context limit: ...
 */
export function parseGeminiModels(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw || /^\s/.test(raw)) continue;
    const line = raw.trim();
    if (!line || /^Available\s+Gemini\s+Models:?$/i.test(line)) continue;
    // "id (Display Name)" or bare "id"
    const m = /^([a-z0-9][a-z0-9._-]*)(?:\s+\(([^)]+)\))?$/i.exec(line);
    if (!m?.[1]) continue;
    const value = m[1];
    const displayName = (m[2] ?? value).trim();
    if (seen.has(value)) continue;
    seen.add(value);

    let description: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) break;
      if (!/^\s/.test(next)) break;
      const descMatch = /^\s*Description:\s*(.+)$/.exec(next);
      if (descMatch?.[1]) description = descMatch[1].trim();
    }

    models.push({
      value,
      displayName,
      supportsEffort: false,
      ...(description ? { description } : {}),
    });
  }

  return models;
}

export type RunGeminiModels = (executable: string) => Promise<string>;

const defaultRunModels: RunGeminiModels = (executable) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--list-models'],
      { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });

export async function loadGeminiModels(
  executable: string,
  run: RunGeminiModels = defaultRunModels,
): Promise<ModelOption[]> {
  return parseGeminiModels(await run(executable));
}
