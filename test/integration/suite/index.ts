import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Минимальный раннер без mocha: каждый `*.test.js` экспортирует `run()`. */
export async function run(): Promise<void> {
  const files = readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
  let failed = 0;
  for (const f of files) {
    const mod = (await import(resolve(__dirname, f))) as {
      tests: Record<string, () => Promise<void>>;
    };
    for (const [name, fn] of Object.entries(mod.tests)) {
      try {
        await fn();
        console.log(`  ok   ${f}: ${name}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL ${f}: ${name}\n`, e);
      }
    }
  }
  if (failed) throw new Error(`Интеграционных тестов упало: ${failed}`);
}
