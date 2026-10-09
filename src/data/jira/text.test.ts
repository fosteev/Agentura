// Скопировано из fosteev/jiraffe 0.7.0 test/aiContext.test.ts (htmlToText, issueContext).
import { describe, expect, it } from 'vitest';
import { AI_COMMENTS, htmlToText, issueContext } from './text';
import type { IssueDetail } from './types';

const detail = (descriptionHtml: string, comments: string[] = []): IssueDetail => ({
  instanceId: 'i', key: 'ABC-1', summary: 'Fix login', type: 'Bug', status: 'Open', statusCategory: 'new', updated: '2026-10-02', watchers: [], descriptionHtml,
  fixVersions: [{ id: '1', name: '2.0' }], labels: ['auth'], components: [], created: '2026-10-01', timetracking: {}, attachments: [], history: [],
  assignee: { id: 'u', name: 'Ann' },
  comments: comments.map((bodyHtml, n) => ({ id: String(n), created: `c${n}`, bodyHtml, author: { id: 'b', name: 'Bob' } })),
});

describe('htmlToText', () => {
  it('блоки — строки, списки — пункты, ссылки — с адресом, сущности раскодированы', () => {
    const html = '<p>Hello&nbsp;<b>world</b> &amp; &lt;you&gt; &#8212; &#x41;</p><ul><li>one</li><li>two</li></ul><p>see <a href="https://x.test/a">docs</a>, <a href="https://x.test/b">https://x.test/b</a></p>';
    expect(htmlToText(html)).toBe('Hello world & <you> — A\n\n- one\n- two\n\nsee docs (https://x.test/a), https://x.test/b');
  });

  it('картинки — [image], переносы <br>, лишние пустые строки схлопываются', () => {
    expect(htmlToText('<p>a<br/>b</p><p></p><p></p><span class="img-ph" data-img="i0">pic.png</span><img src="x">')).toBe('a\nb\n\n[image][image]');
  });
});

describe('issueContext', () => {
  it('поля, описание и комментарии; пустые поля пропущены', () => {
    const s = issueContext({ instanceName: 'Work', issue: detail('<p>Steps</p>', ['<p>ok</p>']) }, 'https://j.test/browse/ABC-1');
    expect(s).toContain('# ABC-1: Fix login\n');
    expect(s).toContain('- URL: https://j.test/browse/ABC-1\n');
    expect(s).toContain('- Assignee: Ann\n');
    expect(s).toContain('- Fix versions: 2.0\n');
    expect(s).not.toContain('Priority');
    expect(s).not.toContain('Components');
    expect(s).toContain('## Description\n\nSteps\n');
    expect(s).toContain('## Comments (1)\n\n### Bob, c0\n\nok\n');
  });

  it('без описания — (empty); комментариев больше лимита — последние', () => {
    const many = Array.from({ length: AI_COMMENTS + 3 }, (_, n) => `<p>m${n}</p>`);
    const s = issueContext({ instanceName: 'Work', issue: detail('', many) }, 'u');
    expect(s).toContain('## Description\n\n(empty)\n');
    expect(s).toContain(`## Comments (last ${AI_COMMENTS} of ${AI_COMMENTS + 3})`);
    expect(s).not.toContain('\nm2\n');
    expect(s).toContain(`\nm${AI_COMMENTS + 2}\n`);
  });
});

