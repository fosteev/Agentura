import { parseDiffBlocks } from './patch';
import { readEditDetail, type EditDetail, type StorageLog } from './storage';

export interface EditLookup {
  root: string;
  conversationId: string;
  /** Индекс шага tool из стрима (= индекс GENERIC-результата в транскрипте). */
  stepIndex: number;
  /** Имя инструмента agy (`replace_file_content`). */
  agyName: string;
  /** Карточка: `Edit` | `MultiEdit` | `Write`. */
  cardName: string;
  targetFile: string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Структурный результат правки в форме `tool_use_result` Claude (`filePath`, `structuredPatch`, `oldString`/
 * `newString`, у Write — `content`): его читают `editStats`/`appliedSides`. `originalFile` не даём — agy его не
 * отдаёт, только ханки. Транскрипта нет или в нём нет ни диффа, ни аргументов — `undefined` (карточка без диффа).
 */
export async function editResultOf(
  lookup: EditLookup,
  options: { retries?: number; delayMs?: number; log?: StorageLog; signal?: AbortSignal } = {},
): Promise<Record<string, unknown> | undefined> {
  const detail = await readEditDetail(lookup.root, lookup.conversationId, lookup.stepIndex, lookup.agyName, lookup.targetFile, options);
  return detail ? editResultFrom(detail, lookup.cardName, lookup.targetFile) : undefined;
}

/** То же из уже прочитанных вызова и результата (живая правка и история — один разбор). */
export function editResultFrom(
  detail: EditDetail,
  cardName: string,
  targetFile: string | undefined,
): Record<string, unknown> | undefined {
  const hunks = parseDiffBlocks(detail.resultText);
  const args = detail.args;
  const lookup = { cardName, targetFile };
  const result: Record<string, unknown> = {};
  if (lookup.targetFile) result['filePath'] = lookup.targetFile;
  if (lookup.cardName === 'Write') {
    const content = str(args['CodeContent']);
    if (content !== undefined) result['content'] = content;
    // новый файл agy подтверждает «Created file …»; иначе (перезапись, `Overwrite`) — `update`: «до» неизвестно,
    // и выдавать перезапись за новый файл нельзя
    result['type'] = !hunks && /^Created file /m.test(detail.resultText) ? 'create' : 'update';
  } else {
    // multi_replace: старый/новый текст берём, только если кусок один (иначе — только ханки)
    const chunks = Array.isArray(args['ReplacementChunks']) ? (args['ReplacementChunks'] as Record<string, unknown>[]) : undefined;
    const single = chunks?.length === 1 ? chunks[0] : chunks ? undefined : args;
    const oldString = str(single?.['TargetContent']);
    const newString = str(single?.['ReplacementContent']);
    if (oldString !== undefined) result['oldString'] = oldString;
    if (newString !== undefined) result['newString'] = newString;
    if (args['AllowMultiple'] === true) result['replaceAll'] = true;
  }
  if (hunks) result['structuredPatch'] = hunks;
  const meaningful = hunks !== undefined || result['content'] !== undefined || result['oldString'] !== undefined;
  return meaningful ? result : undefined;
}
