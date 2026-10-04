import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitCommitView, GitFileStatus, GitRepoView, GitSnapshot } from '../../shared/git';
import type { GitLayout } from '../../settings';
import { menuKeys } from '../a11y';
import {
  agentCount,
  cleanRepos,
  commitButton,
  commitMessage,
  commitTargets,
  commitWhen,
  fileRows,
  pickedRepo,
  repoCount,
  sectionRows,
  summaryLeft,
  syncView,
  totalCount,
  unifiedButton,
  unifiedSection,
  type GitFileRow,
  type GitRow,
  type UnifiedGroup,
} from '../gitView';
import { ui } from '../strings';
import {
  clearGitError,
  EMPTY_DRAFT,
  GIT_ANY,
  GIT_UNIFIED,
  gitCommitted,
  gitDrafts,
  gitErrors,
  gitGenerating,
  gitTargets,
  requestGitMessage,
  setGitDraft,
  setGitTarget,
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
  layout = 'stack',
  repoRoot,
  onTree,
  onAgentOnly,
  onRepo,
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
  /** Раскладка при нескольких репозиториях (`agentura.git.layout`); один репозиторий её не читает. */
  layout?: GitLayout;
  /** Выбранный в `picker` репозиторий (корень); нет или исчез — первый с изменениями. */
  repoRoot?: string | undefined;
  onTree: (tree: boolean) => void;
  onAgentOnly: (on: boolean) => void;
  onRepo?: (root: string) => void;
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
        <button class="open-repo" onClick={() => send({ type: 'git.openRepository' })}>
          {t.openRepo}
        </button>
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
  // имя рабочей папки (последний сегмент cwd), как в прототипе: «queue/ · 3 репозитория · 7 изменений»
  const folder = cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const ws = (
    <div class="ws">
      <span class="rp">{I.repo}</span>
      {folder && <b>{folder}/</b>}
      <span>
        {t.repos(repos.length)} · {t.changes(totalCount(snapshot))}
      </span>
      <span class="r">
        <button
          class="ib"
          data-tip={t.fetchAll}
          aria-label={t.fetchAll}
          onClick={() => send({ type: 'git.sync', op: 'fetch' })}
        >
          {I.fetch}
        </button>
      </span>
    </div>
  );
  if (layout === 'picker') {
    const sel = pickedRepo(snapshot, repoRoot) ?? repos[0]!;
    return shell(
      <>
        {ws}
        <div class="pick" role="group" aria-label={t.repoPick}>
          {repos.map((r) => (
            <PickRow key={r.root} repo={r} on={r.root === sel.root} onPick={() => onRepo?.(r.root)} />
          ))}
        </div>
        <div class="scroll">
          {bar}
          {block(sel, false)}
        </div>
        <CommitBox repo={sel} />
      </>,
    );
  }
  if (layout === 'unified') {
    return shell(
      <>
        {ws}
        <div class="scroll">
          {bar}
          <UnifiedSections
            snapshot={snapshot}
            agentPaths={agentPaths}
            cwd={cwd}
            tree={tree}
            agentOnly={agentOnly}
          />
        </div>
        <UnifiedCommit snapshot={snapshot} />
      </>,
    );
  }
  return shell(
    <>
      {ws}
      <div class="scroll">
        {bar}
        {repos.map((r) => block(r, true))}
      </div>
    </>,
  );
}

/** Строка списка репозиториев раскладки `picker`: выбор по клику, у выбранного — fetch / pull / push. */
function PickRow({ repo, on, onPick }: { repo: GitRepoView; on: boolean; onPick: () => void }) {
  const n = repoCount(repo);
  return (
    <div class={on ? 'p on' : 'p'} onClick={onPick}>
      <span class="rd" />
      <button class="nm" aria-pressed={on} onClick={onPick}>
        {repo.name}
      </button>
      <span class="bw" onClick={(e) => e.stopPropagation()}>
        <Branch repo={repo} />
      </span>
      <Sync repo={repo} compact />
      <span class={n ? 'n' : 'n z'}>{n || '—'}</span>
      {on && (
        <span onClick={(e) => e.stopPropagation()}>
          <SyncButtons repo={repo} />
        </span>
      )}
    </div>
  );
}

function FileRows({
  repo,
  rows,
  staged,
  tree,
}: {
  repo: GitRepoView;
  rows: GitRow[];
  staged: boolean;
  tree: boolean;
}) {
  return (
    <>
      {rows.map((r) =>
        r.kind === 'dir' ? (
          <div class="dr" key={`d:${r.path}`} style={{ '--lv': r.level }}>
            <span class="chev">▾</span>
            {r.name}
          </div>
        ) : (
          <FileLine key={r.path} repo={repo} row={r} staged={staged} tree={tree} />
        ),
      )}
    </>
  );
}

/** Раскладка `unified`: две общие секции на все репозитории с подзаголовками репо, чистые — строками внизу. */
function UnifiedSections({
  snapshot,
  agentPaths,
  cwd,
  tree,
  agentOnly,
}: {
  snapshot: GitSnapshot;
  agentPaths: ReadonlySet<string>;
  cwd?: string | undefined;
  tree: boolean;
  agentOnly: boolean;
}) {
  const t = g();
  const clean = cleanRepos(snapshot);
  const sec = (staged: boolean) => (
    <UnifiedSection
      key={staged ? 'st' : 'un'}
      staged={staged}
      repos={snapshot.repos}
      {...unifiedSection(snapshot, staged, agentPaths, agentOnly, tree, cwd)}
      agentOnly={agentOnly}
      tree={tree}
    />
  );
  return (
    <>
      {sec(false)}
      {sec(true)}
      {clean.length > 0 && (
        <>
          <h6>{t.cleanHeading}</h6>
          {clean.map((r) => (
            <div class="rg" key={r.root}>
              <span class="nm dim">{r.name}</span>
              <Branch repo={r} />
              <Sync repo={r} compact />
              <SyncButtons repo={r} />
            </div>
          ))}
        </>
      )}
    </>
  );
}

function UnifiedSection({
  staged,
  repos,
  total,
  groups,
  tree,
  agentOnly,
}: {
  staged: boolean;
  repos: readonly GitRepoView[];
  total: number;
  groups: UnifiedGroup[];
  tree: boolean;
  agentOnly: boolean;
}) {
  const t = g();
  const [open, setOpen] = useState(true);
  const busy = repos.some((r) => r.busy);
  // «все» — по каждому репозиторию своим запросом (у запроса один root)
  const all = () => {
    for (const r of repos) {
      const paths = (staged ? r.staged : r.unstaged).map((f) => f.path);
      if (paths.length === 0) continue;
      clearGitError(r.root);
      send({ type: staged ? 'git.unstage' : 'git.stage', root: r.root, paths });
    }
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
          <button class={staged ? 'all' : 'all pri'} disabled={busy} onClick={all}>
            {staged ? t.unstageAll : t.stageAll}
          </button>
        )}
      </div>
      {open &&
        (groups.length === 0 ? (
          <div class="empty">{emptyText}</div>
        ) : (
          groups.map((gr) => (
            <div class="rgrp" key={gr.repo.root}>
              <div class="rg">
                <span class="nm">{gr.repo.name}</span>
                <span class="br">
                  {I.branch}
                  <span>{gr.repo.branch ?? '—'}</span>
                </span>
              </div>
              <FileRows repo={gr.repo} rows={gr.rows} staged={staged} tree={tree} />
            </div>
          ))
        ))}
    </>
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

/** ↓/↑ против upstream; `compact` — строка репозитория в стопке / списке: «новая» вместо «не опубликована». */
function Sync({ repo, compact = false }: { repo: GitRepoView; compact?: boolean }) {
  const t = g();
  const s = syncView(repo);
  if (s.unpublished) {
    return (
      <span class="sync">
        <span class="unpub" data-tip={t.unpublishedTitle}>
          {compact ? t.unpublishedShort : t.unpublished}
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
        <Sync repo={repo} compact />
        <SyncButtons repo={repo} />
      </div>
      {open && n > 0 && (
        <>
          {body}
          <CommitBox repo={repo} compact />
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
          <FileRows repo={repo} rows={list} staged={staged} tree={tree} />
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

function ErrorLine({ err, onClose, name }: { err: GitErrorView; onClose: () => void; name?: string }) {
  const t = g();
  return (
    <div class="err" role="alert">
      <span>
        {name ? `${name}: ` : ''}
        {t.errorOp(err.op, err.message)}
      </span>
      <button class="ib" aria-label={t.errorClose} onClick={onClose}>
        ×
      </button>
    </div>
  );
}

interface FormButton {
  disabled: boolean;
  /** Подпись кнопки целиком (без хвоста «→ ветка»). */
  label: string;
  branch?: string;
  hint: string;
}

interface FormMenu {
  /** «Коммит и push» недоступен. */
  pushOff: boolean;
  /** Пункт «Коммит всех изменений»; нет — пункта нет (в `unified` его нет). */
  all?: { off: boolean };
}

/**
 * Поле коммита: заголовок со счётчиком, описание, amend / «и push», кнопка с меню ▾. Общее для одного репозитория,
 * стопки (`compact` — строка, раскрывается на фокус) и общего коммита `unified` (`targets` над полем).
 */
function CommitForm({
  draftKey,
  tail,
  btn,
  menu,
  busy,
  errors,
  targets,
  compact,
  note,
  gen,
  onGo,
}: {
  draftKey: string;
  /** ✦: репозитории с непустым индексом, по которым модель пишет сообщение; пусто — кнопка выключена. */
  gen: readonly string[];
  /** Хвост подсказки в поле заголовка (имя репозитория). */
  tail?: string;
  btn: FormButton;
  menu: FormMenu;
  busy: boolean;
  errors?: preact.ComponentChildren;
  targets?: preact.ComponentChildren;
  compact?: boolean;
  note?: preact.ComponentChildren;
  onGo: (o: { push?: boolean; all?: boolean }) => void;
}) {
  const t = g();
  const d = gitDrafts.value[draftKey] ?? EMPTY_DRAFT;
  const [menuOpen, setMenu] = useState(false);
  const [focus, setFocus] = useState(false);
  // стопка: строка «заголовок + Коммит», на фокус — полное поле
  const [expanded, setExpanded] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sum = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
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
  }, [menuOpen]);
  useEffect(() => {
    if (compact && expanded) sum.current?.focus();
  }, [compact, expanded]);
  const left = summaryLeft(d.summary);
  const generating = draftKey in gitGenerating.value;
  const go = (o: { push?: boolean; all?: boolean } = {}) => {
    setMenu(false);
    onGo(o);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      if (!btn.disabled) go();
    }
  };
  const collapsed = !!compact && !expanded;
  // фокус ушёл из поля целиком (не на соседний элемент внутри) — снова строка; проверка после тика: фокус мог
  // перейти на заменённый элемент (строка → полное поле)
  const onOut = () => {
    if (!compact) return;
    setTimeout(() => {
      if (!wrap.current?.contains(document.activeElement)) setExpanded(false);
    }, 0);
  };
  if (collapsed) {
    return (
      <div class="cml" data-root={draftKey} ref={wrap}>
        <input
          class="in"
          type="text"
          aria-label={t.summaryAria}
          placeholder={`${t.summaryPlaceholder}${tail ? ` · ${tail}` : ''}`}
          value={d.summary}
          onInput={(e) =>
            setGitDraft(draftKey, { summary: (e.currentTarget as HTMLInputElement).value })
          }
          onFocus={() => setExpanded(true)}
        />
        <button
          class={btn.disabled ? 'go-min' : 'go-min pri'}
          disabled={btn.disabled}
          data-tip={btn.hint}
          onClick={() => go()}
        >
          {t.commitCompact}
        </button>
      </div>
    );
  }
  const label = btn.label;
  return (
    <div class="cm" data-root={draftKey} ref={wrap} onFocusOut={onOut}>
      {errors}
      {targets}
      <div class={focus ? 'box focus' : 'box'}>
        <div class="sum">
          <input
            class="t"
            type="text"
            ref={sum}
            aria-label={t.summaryAria}
            placeholder={`${t.summaryPlaceholder}${tail ? ` · ${tail}` : ''}`}
            value={d.summary}
            onInput={(e) =>
              setGitDraft(draftKey, { summary: (e.currentTarget as HTMLInputElement).value })
            }
            onKeyDown={onKey}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
          />
          {d.summary && <span class={left.over ? 'n over' : 'n'}>{left.left}</span>}
          <button
            class={generating ? 'ib gen busy' : 'ib gen'}
            disabled={gen.length === 0}
            aria-busy={generating}
            data-tip={generating ? t.generating : gen.length === 0 ? t.needStage : t.generate}
            aria-label={t.generate}
            onClick={() => requestGitMessage(draftKey, gen)}
          >
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
            setGitDraft(draftKey, { desc: (e.currentTarget as HTMLTextAreaElement).value })
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
              setGitDraft(draftKey, { amend: (e.currentTarget as HTMLInputElement).checked })
            }
          />
          {t.amend}
        </label>
        <label>
          <input
            type="checkbox"
            checked={d.push}
            onChange={(e) =>
              setGitDraft(draftKey, { push: (e.currentTarget as HTMLInputElement).checked })
            }
          />
          {t.andPush}
        </label>
        {note && <span class="r">{note}</span>}
      </div>
      <div class={btn.disabled ? 'go off' : 'go'} ref={pop} onKeyDown={menuKeys}>
        <button class="main" disabled={btn.disabled} data-tip={btn.hint} onClick={() => go()}>
          {label}
          {btn.branch && <small> → {btn.branch}</small>}
        </button>
        <button
          class="more"
          data-tip={t.more}
          aria-label={t.more}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy}
          onClick={() => setMenu(!menuOpen)}
        >
          ▾
        </button>
        {menuOpen && (
          <div class="menu up" role="menu">
            <button
              class="it"
              role="menuitem"
              disabled={menu.pushOff}
              onClick={() => go({ push: true })}
            >
              {t.commitPush}
            </button>
            {menu.all && (
              <button
                class="it"
                role="menuitem"
                disabled={menu.all.off}
                onClick={() => go({ all: true })}
              >
                {t.commitAll}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Поле коммита одного репозитория; в стопке (`compact`) — строкой, раскрывается на фокус. */
function CommitBox({ repo, compact }: { repo: GitRepoView; compact?: boolean }) {
  const t = g();
  const d = gitDrafts.value[repo.root] ?? EMPTY_DRAFT;
  const message = commitMessage(d.summary, d.desc);
  const btn = commitButton(repo, { message, amend: d.amend });
  const btnAll = commitButton(repo, { message, amend: d.amend, all: true });
  const err = errorFor(repo.root, true);
  const hint =
    btn.why === 'empty-index'
      ? t.needStage
      : btn.why === 'empty-message'
        ? t.needMessage
        : btn.why === 'busy'
          ? t.busy
          : t.commitHint;
  return (
    <CommitForm
      draftKey={repo.root}
      tail={repo.name}
      gen={repo.staged.length > 0 ? [repo.root] : []}
      compact={compact}
      busy={!!repo.busy}
      btn={{
        disabled: btn.disabled,
        label: `${d.amend ? t.commitAmend : t.commit}${btn.files ? ` · ${t.filesN(btn.files)}` : ''}`,
        branch: btn.branch,
        hint,
      }}
      menu={{ pushOff: btn.disabled, all: { off: btnAll.disabled } }}
      errors={err && <ErrorLine err={err} onClose={() => clearGitError(repo.root)} />}
      onGo={(o) => {
        clearGitError(repo.root);
        send({
          type: 'git.commit',
          roots: [repo.root],
          message,
          amend: d.amend,
          push: o.push ?? d.push,
          ...(o.all ? { all: true } : {}),
        });
      }}
    />
  );
}

/** Общее поле коммита раскладки `unified`: чипы «в: ☑ repo N», одно сообщение — отдельный коммит в каждый отмеченный. */
function UnifiedCommit({ snapshot }: { snapshot: GitSnapshot }) {
  const t = g();
  const d = gitDrafts.value[GIT_UNIFIED] ?? EMPTY_DRAFT;
  const message = commitMessage(d.summary, d.desc);
  const targets = commitTargets(snapshot, gitTargets.value);
  const btn = unifiedButton(snapshot, targets, { message });
  const names = new Map(snapshot.repos.map((r) => [r.root, r.name]));
  // ошибки по всем репозиториям: отказ одного не прячет остальные
  const errs = Object.entries(gitErrors.value).filter(([root]) => root === GIT_ANY || names.has(root));
  const done = gitCommitted.value.map((r) => names.get(r) ?? r);
  const hint =
    btn.why === 'no-targets'
      ? t.needTarget
      : btn.why === 'empty-message'
        ? t.needMessage
        : btn.why === 'busy'
          ? t.busy
          : t.commitHint;
  const clearAll = () => {
    for (const [root] of errs) clearGitError(root);
    gitCommitted.value = [];
  };
  return (
    <CommitForm
      draftKey={GIT_UNIFIED}
      gen={btn.roots}
      busy={snapshot.repos.some((r) => r.busy)}
      btn={{
        disabled: btn.disabled,
        label: `${d.amend ? `${t.commitAmend} · ` : ''}${t.commitTo(btn.repos)}${btn.files ? ` · ${t.filesN(btn.files)}` : ''}`,
        hint,
      }}
      menu={{ pushOff: btn.disabled }}
      errors={
        <>
          {done.length > 0 && (
            <div class="ok" role="status">
              <span>{t.committed(done.join(', '))}</span>
              <button class="ib" aria-label={t.errorClose} onClick={() => (gitCommitted.value = [])}>
                ×
              </button>
            </div>
          )}
          {errs.map(([root, e]) => (
            <ErrorLine key={root} err={e} name={names.get(root)} onClose={() => clearGitError(root)} />
          ))}
        </>
      }
      targets={
        <div class="tg" role="group" aria-label={t.targetsAria}>
          <span>{t.targetsLabel}</span>
          {targets.map((x) => (
            <label key={x.root} class={x.on ? 'to' : 'to off'}>
              <input
                type="checkbox"
                checked={x.on}
                onChange={(e) => setGitTarget(x.root, (e.currentTarget as HTMLInputElement).checked)}
              />
              {x.name} <span class="mono">{x.files}</span>
            </label>
          ))}
        </div>
      }
      onGo={(o) => {
        clearAll();
        send({
          type: 'git.commit',
          roots: btn.roots,
          message,
          amend: d.amend,
          push: o.push ?? d.push,
        });
      }}
    />
  );
}
