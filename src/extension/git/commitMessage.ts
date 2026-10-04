/**
 * ✦ во вкладке «git» (roadmap 12, этап 4): промпт одноразового запроса по индексу и разбор ответа модели.
 * Чистые функции — без git и движка; данные собирает `GitService`.
 */

/** Сколько символов `git diff --cached` уходит модели на все репозитории вместе. */
export const MESSAGE_DIFF_LIMIT = 24_000;
/** Модель одноразового запроса. */
export const MESSAGE_MODEL = 'sonnet';
/** Последних заголовков коммитов — образец стиля репозитория. */
export const MESSAGE_SUBJECTS = 5;

/** Индекс одного репозитория для промпта. */
export interface StagedInput {
  name: string;
  /** `git diff --cached --stat`. */
  stat: string;
  /** `git diff --cached`. */
  diff: string;
  /** Заголовки последних коммитов, новые первыми. */
  subjects: string[];
}

export const MESSAGE_SYSTEM = [
  'You write git commit messages for staged changes.',
  'Reply with the commit message only: a subject line of at most 72 characters, then a blank line,',
  'then an optional body that explains what changed and why, wrapped at 72 columns.',
  'No code fences, no quotes, no preamble or commentary.',
  "Match the language, tone and conventions (prefixes, capitalisation, tense) of the repository's",
  'recent commit subjects; if there are none, write in English in the imperative mood.',
  'Do not add trailers such as Co-Authored-By or Signed-off-by.',
].join(' ');

/**
 * Доли бюджета диффа: короткий дифф берёт сколько ему надо, остаток делят длинные поровну.
 * Сумма не больше `limit`.
 */
export function diffBudgets(lengths: number[], limit = MESSAGE_DIFF_LIMIT): number[] {
  const out = lengths.map(() => 0);
  const order = lengths.map((n, i) => ({ n, i })).sort((a, b) => a.n - b.n);
  let left = limit;
  order.forEach(({ n, i }, k) => {
    const share = Math.floor(left / (order.length - k));
    out[i] = Math.min(n, share);
    left -= out[i]!;
  });
  return out;
}

/** Текст запроса: по каждому репозиторию — стиль (заголовки), `--stat` и дифф с обрезкой. */
export function messagePrompt(repos: StagedInput[], limit = MESSAGE_DIFF_LIMIT): string {
  const budgets = diffBudgets(
    repos.map((r) => r.diff.length),
    limit,
  );
  const parts: string[] = [];
  if (repos.length > 1) {
    parts.push(
      `The same message will be used for a separate commit in each of these ${repos.length} repositories, so describe the change as a whole.`,
    );
  }
  repos.forEach((r, i) => {
    const budget = budgets[i]!;
    const diff = r.diff.length > budget ? r.diff.slice(0, budget) : r.diff;
    const lines = [`## Repository: ${r.name}`, ''];
    lines.push('Recent commit subjects (style reference):');
    lines.push(...(r.subjects.length ? r.subjects.map((s) => `- ${s}`) : ['(no commits yet)']));
    lines.push('', 'Staged changes (git diff --cached --stat):', r.stat.trimEnd(), '');
    lines.push('Staged diff (git diff --cached):', diff.trimEnd());
    if (diff.length < r.diff.length) {
      lines.push(`[diff truncated: first ${diff.length} of ${r.diff.length} characters]`);
    }
    parts.push(lines.join('\n'));
  });
  parts.push('Write the commit message now.');
  return parts.join('\n\n');
}

/**
 * Ответ модели → заголовок и описание. Обёртка ``` и кавычки вокруг всего ответа снимаются; заголовок —
 * первая непустая строка, описание — остальное без пустых строк по краям. Пусто — `undefined`.
 */
export function parseCommitMessage(text: string): { summary: string; desc: string } | undefined {
  let t = text.replace(/\r\n?/g, '\n').trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  if (t.length >= 2 && /^["'`]/.test(t) && t[t.length - 1] === t[0]) t = t.slice(1, -1).trim();
  if (!t) return undefined;
  const lines = t.split('\n');
  const at = lines.findIndex((l) => l.trim() !== '');
  const summary = lines[at]!.trim();
  const desc = lines
    .slice(at + 1)
    .join('\n')
    .replace(/^\s*\n/, '')
    .trimEnd();
  return { summary, desc };
}
