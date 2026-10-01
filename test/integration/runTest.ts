import { resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

/** Запуск интеграционного теста в настоящем VS Code (скачивается в .vscode-test/). */
async function main(): Promise<void> {
  // Если запущено из терминала/расширения VS Code, Electron стартует как голый Node и не принимает флаги.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = resolve(__dirname, '../../..');
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(__dirname, 'suite/index'),
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    // чистый профиль: тест не должен трогать настройки и расширения владельца
    launchArgs: [
      // рабочая папка нужна: без неё agentura.open только предупреждает
      resolve(root, 'test/integration/fixture'),
      '--disable-extensions',
      '--user-data-dir',
      resolve(root, '.vscode-test/user-data'),
    ],
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
