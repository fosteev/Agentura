/** Фикстуры состояний как текст: esbuild подключает `.jsonl` загрузчиком `text` (см. `esbuild.mjs`). */
import empty from '../../test/fixtures/states/empty.jsonl';
import error from '../../test/fixtures/states/error.jsonl';
import limited from '../../test/fixtures/states/limited.jsonl';
import waiting from '../../test/fixtures/states/waiting.jsonl';
import working from '../../test/fixtures/states/working.jsonl';
import type { StateName } from './debugStates';

export const STATE_FIXTURES: Record<StateName, string> = {
  empty,
  working,
  waiting,
  error,
  limited,
};
