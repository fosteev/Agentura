import { describe, expect, it } from 'vitest';
import { diffBudgets, messagePrompt, parseCommitMessage, type StagedInput } from './commitMessage';

const input = (name: string, diff: string, subjects: string[] = ['Fix it']): StagedInput => ({
  name,
  stat: ` x.ts | 1 +\n 1 file changed`,
  diff,
  subjects,
});

describe('diffBudgets', () => {
  it('короткий берёт своё, остаток — длинным поровну; сумма не больше лимита', () => {
    expect(diffBudgets([100], 1000)).toEqual([100]);
    expect(diffBudgets([5000], 1000)).toEqual([1000]);
    expect(diffBudgets([100, 5000, 5000], 1000)).toEqual([100, 450, 450]);
    const b = diffBudgets([10_000, 30, 20_000], 24_000);
    expect(b[1]).toBe(30);
    expect(b.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(24_000);
  });
});

describe('messagePrompt', () => {
  it('стиль, --stat и дифф по репозиторию; обрезка с пометкой', () => {
    const p = messagePrompt([input('api', 'x'.repeat(50), ['feat: add a', 'fix: b'])], 20);
    expect(p).toContain('## Repository: api');
    expect(p).toContain('- feat: add a\n- fix: b');
    expect(p).toContain('x.ts | 1 +');
    expect(p).toContain(`${'x'.repeat(20)}\n[diff truncated: first 20 of 50 characters]`);
    expect(p).not.toContain('x'.repeat(21));
    expect(p).not.toMatch(/separate commit/);
  });

  it('несколько репозиториев — одно сообщение на всех; без коммитов — пометка', () => {
    const p = messagePrompt([input('a', 'da'), input('b', 'db', [])]);
    expect(p).toMatch(/separate commit in each of these 2 repositories/);
    expect(p).toContain(
      '## Repository: b\n\nRecent commit subjects (style reference):\n(no commits yet)',
    );
    expect(p).not.toContain('truncated');
  });
});

describe('parseCommitMessage', () => {
  it('заголовок и описание; обёртка ``` и кавычки снимаются', () => {
    expect(parseCommitMessage('Fix parser\n\nHandle empty lines.\nAnd CRLF.')).toEqual({
      summary: 'Fix parser',
      desc: 'Handle empty lines.\nAnd CRLF.',
    });
    expect(parseCommitMessage('```text\r\nFix parser\r\n\r\n  - item\r\n```')).toEqual({
      summary: 'Fix parser',
      desc: '  - item',
    });
    expect(parseCommitMessage('"Fix parser"')).toEqual({ summary: 'Fix parser', desc: '' });
    expect(parseCommitMessage('\n\n  Only subject  \n')).toEqual({
      summary: 'Only subject',
      desc: '',
    });
  });

  it('пустой ответ — undefined', () => {
    expect(parseCommitMessage('')).toBeUndefined();
    expect(parseCommitMessage('  \n ')).toBeUndefined();
    expect(parseCommitMessage('```\n```')).toBeUndefined();
  });
});
