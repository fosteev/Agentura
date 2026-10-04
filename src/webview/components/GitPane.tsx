import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitCommitView, GitFileStatus, GitRepoView, GitSnapshot } from '../../shared/git';
import { menuKeys } from '../a11y';
import {
  agentCount,
  commitButton,
  commitMessage,
  commitWhen,
  fileRows,
  repoCount,
  sectionRows,
  summaryLeft,
  syncView,
  totalCount,
  type GitFileRow,
} from '../gitView';
import { ui } from '../strings';
import {
  clearGitError,
  EMPTY_DRAFT,
  GIT_ANY,
  gitDrafts,
  gitErrors,
  setGitDraft,
  type GitErrorView,
} from '../store';
import { send } from '../vscode';

const g = () => ui.git;

function svg(d: preact.ComponentChildren, size?: number) {
  return (
    <svg
      class="ico"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      aria-hidden="true"
      style={size ? { width: `${size}px`, height: `${size}px` } : undefined}
    >
      {d}
    </svg>
  );
}
const I = {
  branch: svg(
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3-7 3.8" />
    </>,
    12,
  ),
  repo: svg(
    <>
      <path d="M3.5 2.5h8v11h-8a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
      <path d="M2.5 11.5h9" />
      <path d="M5.5 5h3" />
    </>,
  ),
  fetch: svg(
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" />
      <path d="M13 2.5v3h-3" />
    </>,
  ),
  pull: svg(
    <>
      <path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7" />
      <path d="M3 13.5h10" />
    </>,
  ),
  push: svg(
    <>
      <path d="M8 13.5v-8M4.5 9L8 5.5 11.5 9" />
      <path d="M3 2.5h10" />
    </>,
  ),
  open: svg(
    <>
      <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" />
      <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </>,
  ),
  discard: svg(
    <>
      <path d="M4 6.5h6.5a3 3 0 0 1 0 6H7" />
      <path d="M6.5 3.5L3.5 6.5l3 3" />
    </>,
  ),
  plus: svg(<path d="M8 3.5v9M3.5 8h9" />),
  minus: svg(<path d="M3.5 8h9" />),
  spark: svg(
    <>
      <path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z" />
      <path d="M12.5 11.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />
    </>,
  ),
};

/** Вкладка «git»: рабочее дерево по git. Один репозиторий — как в прототипе `#one`, несколько — стопкой. */
export function GitPane({
  snapshot,
  agentPaths,
  cwd,
  tree,
  agentOnly,
  now,
  hidden,
  labelledBy = 'tab-git',
  onTree,
  onAgentOnly,
}: {
  snapshot: GitSnapshot | undefined;
  /** Пути правок агента за сессию, от cwd (`agentPathSet`). */
  agentPaths: ReadonlySet<string>;
  /** Рабочая папка чата (абсолютный путь): от неё считаются пути правок агента. */
  cwd?: string | undefined;
  tree: boolean;
  agentOnly: boolean;
  now: number;
  hidden?: boolean;
  labelledBy?: string;
  onTree: (tree: boolean) => void;
  onAgentOnly: (on: boolean) => void;
}) {
  const t = g();
  const shell = (body: preact.ComponentChildren) => (
    <section
      class="tabpane gt"
      id="pane-git"
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
    >
      {body}
    </section>
  );
  if (!snapshot) return shell(<div class="empty big">{t.loading}</div>);
  if (snapshot.state === 'unavailable') {
    return shell(
      <div class="empty big">
        <b>{t.unavailable}</b>
        {snapshot.reason && <div>{snapshot.reason}</div>}
      </div>,
    );
  }
  if (snapshot.state === 'none' || snapshot.repos.length === 0) {
    return shell(
      <div class="empty big">
        <b>{t.none}</b>
        <div>{t.noneHint}</div>
      </div>,
    );
  }
  const repos = snapshot.repos;
  const single = repos.length === 1;
  const bar = (
    <Bar
      total={totalCount(snapshot)}
      agent={agentCount(snapshot, agentPaths, cwd)}
      tree={tree}
      agentOnly={agentOnly}
      onTree={onTree}
      onAgentOnly={onAgentOnly}
    />
  );
  const block = (r: GitRepoView, stack: boolean) => (
    <RepoBlock
      repo={r}
      stack={stack}
      agentPaths={agentPaths}
      cwd={cwd}
      tree={tree}
      agentOnly={agentOnly}
      now={now}
    />
  );
  if (single) {
    const r = repos[0]!;
    return shell(
      <>
        <RepoHead repo={r} />
        <div class="scroll">
          {bar}
          {block(r, false)}
        </div>
        <CommitBox repo={r} />
      </>,
    );
  }
  return shell(
    <>
      <div class="ws">
        <span class="rp">{I.repo}</span>
        <b>{t.repos(repos.length)}</b>
        <span>{t.changes(totalCount(snapshot))}</span>
        <span class="r">
          <button
            class="ib"
            data-tip={`${t.fetch}`}
            aria-label={t.fetch}
            onClick={() => send({ type: 'git.sync', op: 'fetch' })}
          >
            {I.fetch}
          </button>
        </span>
      </div>
      <div class="scroll">
        {bar}
        {repos.map((r) => block(r, true))}
      </div>
    </>,
  );
}

function Bar({
  total,
  agent,
  tree,
  agentOnly,
  onTree,
  onAgentOnly,
}: {
  total: number;
  agent: number;
  tree: boolean;
  agentOnly: boolean;
  onTree: (tree: boolean) => void;
  onAgentOnly: (on: boolean) => void;
}) {
  const t = g();
  return (
    <div class="bar">
      <span>{t.changes(total)}</span>
      <button
        class="flt"
        data-tip={t.agentChipTitle}
        aria-pressed={agentOnly}
        onClick={() => onAgentOnly(!agentOnly)}
      >
        <i />
        {t.agentChip(agent)}
      </button>
      <span class="seg" role="group" aria-label={t.modeAria}>
        <button aria-pressed={!tree} onClick={() => onTree(false)}>
          {t.modePath}
        </button>
        <button aria-pressed={tree} onClick={() => onTree(true)}>
          {t.modeTree}
        </button>
      </span>
    </div>
  );
}

function Branch({ repo }: { repo: GitRepoView }) {
  const t = g();
  return (
    <button
      class="br"
      data-tip={t.branchTitle}
      aria-label={`${t.branchTitle}: ${repo.branch ?? ''}`}
      disabled={!!repo.busy}
      onClick={() => {
        clearGitError(repo.root);
        send({ type: 'git.branch', root: repo.root });
      }}
    >
      {I.branch}
      <span>{repo.branch ?? '—'}</span>
      <span class="car">▾</span>
    </button>
  );
}

function Sync({ repo }: { repo: GitRepoView }) {
  const t = g();
  const s = syncView(repo);
  if (s.unpublished) {
    return (
      <span class="sync">
        <span class="unpub" data-tip={t.unpublishedTitle}>
          {t.unpublished}
        </span>
      </span>
    );
  }
  return (
    <span class="sync" data-tip={repo.upstream ? t.syncTitle(repo.upstream) : undefined}>
      <span class={s.behind ? 'pend' : undefined}>
        ↓<b>{s.behind}</b>
      </span>
      <span class={s.ahead ? 'pend' : undefined}>
        ↑<b>{s.ahead}</b>
      </span>
    </span>
  );
}

function SyncButtons({ repo }: { repo: GitRepoView }) {
  const t = g();
  const s = syncView(repo);
  const run = (op: 'fetch' | 'pull' | 'push') => () => {
    clearGitError(repo.root);
    send({ type: 'git.sync', root: repo.root, op });
  };
  const off = !!repo.busy;
  return (
    <span class="sb">
      <button
        class="ib"
        data-tip={t.fetch}
        aria-label={t.fetch}
        disabled={off}
        onClick={run('fetch')}
      >
        {I.fetch}
      </button>
      <button
        class={s.behind ? 'ib on' : 'ib'}
        data-tip={t.pull}
        aria-label={t.pull}
        disabled={off}
        onClick={run('pull')}
      >
        {I.pull}
      </button>
      <button
        class={s.ahead || s.unpublished ? 'ib on' : 'ib'}
        data-tip={s.unpublished ? t.publish : t.push}
        aria-label={s.unpublished ? t.publish : t.push}
        disabled={off}
        onClick={run('push')}
      >
        {I.push}
      </button>
    </span>
  );
}

function RepoHead({ repo }: { repo: GitRepoView }) {
  return (
    <div class="gh">
      <span class="rp">{I.repo}</span>
      <b class="rn">{repo.name}</b>
      <Branch repo={repo} />
      {repo.op && <span class="op">{g().op[repo.op]}</span>}
      <Sync repo={repo} />
      <SyncButtons repo={repo} />
    </div>
  );
}

/** Содержимое репозитория: секции, последние коммиты; в стопке — со своей шапкой и своим полем коммита. */
function RepoBlock({
  repo,
  stack,
  agentPaths,
  cwd,
  tree,
  agentOnly,
  now,
}: {
  repo: GitRepoView;
  stack: boolean;
  agentPaths: ReadonlySet<string>;
  cwd?: string | undefined;
  tree: boolean;
  agentOnly: boolean;
  now: number;
}) {
  const t = g();
  const n = repoCount(repo);
  const [open, setOpen] = useState(n > 0);
  const un = fileRows(repo.unstaged, repo, agentPaths, agentOnly, cwd);
  const st = fileRows(repo.staged, repo, agentPaths, agentOnly, cwd);
  const body = (
    <>
      <Section
        repo={repo}
        staged={false}
        rows={un}
        total={repo.unstaged.length}
        tree={tree}
        agentOnly={agentOnly}
      />
      <Section
        repo={repo}
        staged
        rows={st}
        total={repo.staged.length}
        tree={tree}
        agentOnly={agentOnly}
      />
      {!stack && <History log={repo.log} now={now} />}
    </>
  );
  if (!stack) return body;
  return (
    <div class="rb">
      <div class={n ? 'rh' : 'rh dim'}>
        <button
          class="chev"
          aria-expanded={open}
          aria-label={repo.name}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
        <span class="nm">{repo.name}</span>
        <Branch repo={repo} />
        {n ? <span class="n">{n}</span> : <span class="clean">{t.clean}</span>}
        <Sync repo={repo} />
        <SyncButtons repo={repo} />
      </div>
      {open && n > 0 && (
        <>
          {body}
          <CommitBox repo={repo} />
        </>
      )}
    </div>
  );
}

function Section({
  repo,
  staged,
  rows,
  total,
  tree,
  agentOnly,
}: {
  repo: GitRepoView;
  staged: boolean;
  rows: GitFileRow[];
  total: number;
  tree: boolean;
  agentOnly: boolean;
}) {
  const t = g();
  const [open, setOpen] = useState(true);
  const list = sectionRows(rows, tree);
  const paths = (staged ? repo.staged : repo.unstaged).map((f) => f.path);
  const all = () => {
    clearGitError(repo.root);
    send({ type: staged ? 'git.unstage' : 'git.stage', root: repo.root, paths });
  };
  const emptyText =
    agentOnly && total > 0 ? t.emptyAgent : staged ? t.emptyStaged : t.emptyUnstaged;
  return (
    <>
      <div class="sh">
        <button class="chev" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <span class="tt">{staged ? t.staged : t.unstaged}</span>
        <span class="n">{total}</span>
        {total > 0 && (
          <button class={staged ? 'all' : 'all pri'} disabled={!!repo.busy} onClick={all}>
            {staged ? t.unstageAll : t.stageAll}
          </button>
        )}
      </div>
      {open &&
        (list.length === 0 ? (
          <div class="empty">{emptyText}</div>
        ) : (
          list.map((r) =>
            r.kind === 'dir' ? (
              <div class="dr" key={`d:${r.path}`} style={{ '--lv': r.level }}>
                <span class="chev">▾</span>
                {r.name}
              </div>
            ) : (
              <FileLine key={r.path} repo={repo} row={r} staged={staged} tree={tree} />
            ),
          )
        ))}
    </>
  );
}

function FileLine({
  repo,
  row,
  staged,
  tree,
}: {
  repo: GitRepoView;
  row: GitFileRow;
  staged: boolean;
  tree: boolean;
}) {
  const t = g();
  const off = !!repo.busy;
  const act = (f: () => void) => (e: Event) => {
    e.stopPropagation();
    clearGitError(repo.root);
    f();
  };
  const open = () => send({ type: 'git.open', root: repo.root, path: row.path, staged });
  return (
    <div
      class={`f s-${row.status}${tree ? ' tr' : ''}`}
      style={tree ? { '--lv': row.level } : undefined}
      tabIndex={0}
      data-tip={row.from ? `${row.path} (${t.renamedFrom(row.from)})` : row.path}
      data-path={row.path}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <span class="nm">
        <b>{row.base}</b>
        {!tree && row.dir && <span class="d">{row.dir}</span>}
      </span>
      {row.agent ? <i class="adot" data-tip={t.agentDot} /> : <span />}
      <Stats row={row} />
      <span class="acts">
        <button
          class="ib"
          data-tip={t.openFile}
          aria-label={t.openFile}
          onClick={act(() => send({ type: 'git.openFile', root: repo.root, path: row.path }))}
        >
          {I.open}
        </button>
        {/* конфликт отменой не решается — только правкой или в SCM */}
        {!staged && row.status !== 'C' && (
          <button
            class="ib"
            data-tip={t.discard}
            aria-label={t.discard}
            disabled={off}
            onClick={act(() => send({ type: 'git.discard', root: repo.root, paths: [row.path] }))}
          >
            {I.discard}
          </button>
        )}
        <button
          class="ib"
          data-tip={staged ? t.unstage : t.stage}
          aria-label={staged ? t.unstage : t.stage}
          disabled={off}
          onClick={act(() =>
            send({
              type: staged ? 'git.unstage' : 'git.stage',
              root: repo.root,
              paths: [row.path],
            }),
          )}
        >
          {staged ? I.minus : I.plus}
        </button>
      </span>
      <span class="st" data-tip={t.statusTitle[row.status as GitFileStatus]}>
        {row.status}
      </span>
    </div>
  );
}

function Stats({ row }: { row: GitFileRow }) {
  return (
    <span class="ch mono">
      {row.binary ? (
        g().binary
      ) : (
        <>
          {!!row.add && <span class="add">+{row.add}</span>}
          {!!row.add && !!row.del && ' '}
          {!!row.del && <span class="del">−{row.del}</span>}
        </>
      )}
    </span>
  );
}

function History({ log, now }: { log: GitCommitView[]; now: number }) {
  if (log.length === 0) return null;
  return (
    <>
      <h6>{g().recent}</h6>
      <div class="hs">
        {log.map((c) => (
          <div class={c.unpushed ? 'c up' : 'c'} key={c.hash}>
            <span class="dot" />
            <span class="h">{c.hash}</span>
            <span class="m" data-tip={c.subject}>
              {c.subject}
            </span>
            <span class="w">
              {c.unpushed ? '↑ ' : ''}
              {commitWhen(c.at, now)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function errorFor(root: string, first: boolean): GitErrorView | undefined {
  const all = gitErrors.value;
  return all[root] ?? (first ? all[GIT_ANY] : undefined);
}

/** Поле коммита репозитория: заголовок со счётчиком, описание, amend / «и push», кнопка с меню ▾. */
function CommitBox({ repo }: { repo: GitRepoView }) {
  const t = g();
  const d = gitDrafts.value[repo.root] ?? EMPTY_DRAFT;
  const [menu, setMenu] = useState(false);
  const [focus, setFocus] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenu(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);
  const message = commitMessage(d.summary, d.desc);
  const btn = commitButton(repo, { message, amend: d.amend });
  const btnAll = commitButton(repo, { message, amend: d.amend, all: true });
  const left = summaryLeft(d.summary);
  const err = errorFor(repo.root, true);
  const go = (o: { push?: boolean; all?: boolean } = {}) => {
    clearGitError(repo.root);
    setMenu(false);
    send({
      type: 'git.commit',
      roots: [repo.root],
      message,
      amend: d.amend,
      push: o.push ?? d.push,
      ...(o.all ? { all: true } : {}),
    });
  };
  const hint =
    btn.why === 'empty-index'
      ? t.needStage
      : btn.why === 'empty-message'
        ? t.needMessage
        : btn.why === 'busy'
          ? t.busy
          : t.commitHint;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      if (!btn.disabled) go();
    }
  };
  const label = `${d.amend ? t.commitAmend : t.commit}${btn.files ? ` · ${t.filesN(btn.files)}` : ''}`;
  return (
    <div class="cm" data-root={repo.root}>
      {err && (
        <div class="err" role="alert">
          <span>{t.errorOp(err.op, err.message)}</span>
          <button class="ib" aria-label={t.errorClose} onClick={() => clearGitError(repo.root)}>
            ×
          </button>
        </div>
      )}
      <div class={focus ? 'box focus' : 'box'}>
        <div class="sum">
          <input
            class="t"
            type="text"
            aria-label={t.summaryAria}
            placeholder={`${t.summaryPlaceholder} · ${repo.name}`}
            value={d.summary}
            onInput={(e) =>
              setGitDraft(repo.root, { summary: (e.currentTarget as HTMLInputElement).value })
            }
            onKeyDown={onKey}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
          />
          {d.summary && <span class={left.over ? 'n over' : 'n'}>{left.left}</span>}
          <button class="ib gen" disabled data-tip={t.generateSoon} aria-label={t.generate}>
            {I.spark}
          </button>
        </div>
        <textarea
          class="desc"
          rows={2}
          aria-label={t.descAria}
          placeholder={t.descPlaceholder}
          value={d.desc}
          onInput={(e) =>
            setGitDraft(repo.root, { desc: (e.currentTarget as HTMLTextAreaElement).value })
          }
          onKeyDown={onKey}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        />
      </div>
      <div class="opt">
        <label>
          <input
            type="checkbox"
            checked={d.amend}
            onChange={(e) =>
              setGitDraft(repo.root, { amend: (e.currentTarget as HTMLInputElement).checked })
            }
          />
          {t.amend}
        </label>
        <label>
          <input
            type="checkbox"
            checked={d.push}
            onChange={(e) =>
              setGitDraft(repo.root, { push: (e.currentTarget as HTMLInputElement).checked })
            }
          />
          {t.andPush}
        </label>
      </div>
      <div class={btn.disabled ? 'go off' : 'go'} ref={pop} onKeyDown={menuKeys}>
        <button class="main" disabled={btn.disabled} data-tip={hint} onClick={() => go()}>
          {label}
          {btn.branch && <small> → {btn.branch}</small>}
        </button>
        <button
          class="more"
          data-tip={t.more}
          aria-label={t.more}
          aria-haspopup="menu"
          aria-expanded={menu}
          disabled={!!repo.busy}
          onClick={() => setMenu(!menu)}
        >
          ▾
        </button>
        {menu && (
          <div class="menu up" role="menu">
            <button
              class="it"
              role="menuitem"
              disabled={btn.disabled}
              onClick={() => go({ push: true })}
            >
              {t.commitPush}
            </button>
            <button
              class="it"
              role="menuitem"
              disabled={btnAll.disabled}
              onClick={() => go({ all: true })}
            >
              {t.commitAll}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
