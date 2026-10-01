import { describe, expect, it } from 'vitest';
import { alwaysButton, planView, ruleSubject } from './cardView';

describe('кнопка «всегда»', () => {
  it('правило Bash → команда без хвоста `:*` / ` *`, подпись о .claude/settings.local.json', () => {
    expect(ruleSubject('Bash(npm test:*)')).toBe('npm test');
    expect(ruleSubject('Bash(echo probe *)')).toBe('echo probe');
    expect(ruleSubject('Bash(node -e "console.log(1)")')).toBe('node -e "console.log(1)"');
    expect(ruleSubject('WebFetch')).toBe('WebFetch');
    expect(
      alwaysButton({ rules: ['Bash(npm test:*)'], destination: 'localSettings', directories: [] }),
    ).toEqual({
      label: 'Всегда для',
      code: 'npm test',
      hint: '«всегда» пишется в .claude/settings.local.json',
    });
  });

  it('правила с разными destination: подпись называет все места', () => {
    expect(
      alwaysButton({
        rules: ['Bash(a)', 'Bash(b)'],
        destination: 'localSettings',
        destinations: ['localSettings', 'userSettings'],
        directories: [],
      })?.hint,
    ).toBe('«всегда» пишется в .claude/settings.local.json, ~/.claude/settings.json');
  });

  it('несколько правил, папки на сессию, только режим, ничего', () => {
    expect(
      alwaysButton({
        rules: ['Bash(a)', 'Bash(b)'],
        destination: 'localSettings',
        directories: ['/x'],
      }),
    ).toMatchObject({
      code: 'a +1',
      // папка на сессию уходит вместе с правилом — подпись об этом говорит
      hint: '«всегда» пишется в .claude/settings.local.json · и папка /x до конца сессии',
    });
    expect(alwaysButton({ rules: [], directories: ['/p/tmp'] })).toMatchObject({
      label: 'Всегда для папки',
      code: '/p/tmp',
      hint: '«всегда» — до конца сессии',
    });
    expect(alwaysButton({ rules: [], directories: [], mode: 'acceptEdits' })?.label).toBe(
      'Принимать правки до конца сессии',
    );
    expect(alwaysButton(undefined)).toBeUndefined();
  });
});

describe('разбор плана', () => {
  it('план из пробы (04-plan-mode): заголовок, 4 шага, 1 файл', () => {
    const plan =
      '# План: маркер в конец README.md\n\n## Context\nВ конец `README.md` (15 строк) нужно добавить строку `<!-- sdk-probe plan -->`.\n\n## Шаги\n1. Проверить, что файл заканчивается переводом строки.\n2. Дописать маркер.\n3. Проверить `tail -3 README.md`.\n4. Проверить через `git diff README.md`.\n\n## Файлы\n- `/Users/fost/Projects/Agentura/README.md`\n';
    const v = planView(plan);
    expect(v.title).toBe('План: маркер в конец README.md');
    expect(v.steps).toBe(4);
    expect(v.files).toEqual([{ path: '/Users/fost/Projects/Agentura/README.md' }]);
    expect(v.body.startsWith('## Context')).toBe(true);
  });

  it('файлы с пометкой, шаги без секции, план без заголовка', () => {
    const v = planView(
      'Сначала так.\n\n1. Раз\n2. Два\n\n### Critical files\n- `src/a.ts` — правка\n- **src/b.ts** — новый\n',
    );
    expect(v.title).toBe('План');
    expect(v.steps).toBe(2);
    expect(v.files).toEqual([
      { path: 'src/a.ts', note: 'правка' },
      { path: 'src/b.ts', note: 'новый' },
    ]);
  });
});
