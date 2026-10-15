import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import {
  CODE_LIMITS,
  type CodeBranch,
  type CodeChat,
  type CodeCommit,
  type CodeFile,
  type CodeRepo,
} from '../../shared/task';
import { diffBodyHtml, type DiffBody } from '../diffView';
import { languageFor } from '../highlight';
import { taskCode, taskCodeCommits, taskCodeDiff } from '../store';
import { ui } from '../strings';
import {
  branchSet,
  codeFor,
  commitSet,
  dirtySet,
  howCommands,
  prefillText,
  repoHasContent,
  splitPath,
  stepIndex,
  visibleBranches,
  type DiffSet,
} from '../taskCodeView';
import { dateTimeLabel } from '../taskView';
import { send } from '../vscode';
import { Mark } from './TaskPane';

/** Счётчик запросов патча: ответ с другим `req` — устаревший (быстрый j/k, закрытие дифф-панели). */
let reqSeq = 0;

type Sel = { root: string; sha: string };

const keyOf = (s: Sel): string => `${s.root}\0${s.sha}`;

/** Строка, на которую можно нажать (div: внутри бывают свои кнопки — отметки чатов). */
function rowProps(onAct: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onAct,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onAct();
      }
    },
  };
}

function Stat({ f }: { f: { add?: number; del?: number; binary?: true } }) {
  if (f.binary) return <em class="dim">{ui.task.code.binary}</em>;
  if (f.add === undefined && f.del === undefined) return <em />;
  return (
    <em>
      <span class="add">+{f.add ?? 0}</span> <span class="del">−{f.del ?? 0}</span>
    </em>
  );
}

function FileName({ f }: { f: CodeFile }) {
  const [dir, base] = splitPath(f.path);
  return (
    <span class="nm" title={f.from ? `${f.path} (${ui.task.code.renamedFrom(f.from)})` : f.path}>
      {dir && <i>{dir}</i>}
      {base}
    </span>
  );
}

function StatusLetter({ s }: { s: string }) {
  return (
    <span class={`st ${s}`} data-tip={ui.task.code.statusTitle[s] ?? s}>
      {s}
    </span>
  );
}

function ChatMarks({ chats }: { chats: CodeChat[] }) {
  return (
    <span class="chs">
      {chats.map((c) => (
        <button
          key={c.id}
          class="chm"
          data-tip={ui.task.code.chatMark(c.title || ui.task.tabUntitled)}
          aria-label={ui.task.code.chatMark(c.title || ui.task.tabUntitled)}
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'task.openChat', sessionId: c.id });
          }}
        >
          <Mark provider={c.provider as AgentProvider | undefined} />
        </button>
      ))}
    </span>
  );
}

function CommitTags({ c, repo }: { c: CodeCommit; repo: CodeRepo }) {
  const t = ui.task.code;
  return (
    <span class="tags">
      {c.src === 'branch' ? (
        <span class="src br" data-tip={t.srcBranchTitle(c.branch ?? '')}>
          {t.srcBranch}
        </span>
      ) : (
        <span class="src" data-tip={t.srcKeyTitle}>
          {t.srcKey}
        </span>
      )}
      {c.unpushed && (
        <span class="up" data-tip={t.unpushedTitle}>
          {t.unpushed}
        </span>
      )}
      {!c.unpushed && c.inBase && repo.base && (
        <span class="ind" data-tip={t.inBaseTitle(repo.base)}>
          {t.inBase(repo.base)}
        </span>
      )}
    </span>
  );
}

/**
 * Вкладка «код» полосы задачи (roadmap 24; `prototype/screens/task-git.html#b`): репозитории задачи с ветками,
 * коммитами и незакоммиченными правками агентов, детали коммита справа, встроенный дифф на месте списка
 * (список остаётся смонтированным и прячется — скролл не теряется), всплывашка «как ищем?».
 */
export function TaskCode({
  taskKey,
  hidden,
  diffMode,
  onDiffMode,
  onToChat,
}: {
  taskKey: string;
  hidden: boolean;
  diffMode: 'inline' | 'split';
  onDiffMode: (m: 'inline' | 'split') => void;
  /** «в чат ↳»: после вставки текста перейти на вкладку «чат». */
  onToChat: () => void;
}) {
  const t = ui.task.code;
  const state = codeFor(taskCode.value, taskKey);
  const [sel, setSel] = useState<Sel | undefined>();
  const [how, setHow] = useState(false);
  // sha — дифф коммита: подсвечиваем файл справа; выбор другого коммита при открытом диффе переключает дифф на него
  const [diff, setDiff] = useState<{ set: DiffSet; i: number; sha?: string } | undefined>();
  // коммит, выбранный при открытом диффе: как придут его файлы — открыть его дифф
  const [follow, setFollow] = useState<string | undefined>();
  // номер запроса открытого файла: показываем только ответ с этим `req`, остальные устарели; 0 — дифф закрыт
  const [req, setReq] = useState(0);

  // первое открытие вкладки (и смена задачи / сброс при смене чата вкладки) — загрузка; дальше хост обновляет сам
  const loaded = !!state;
  useEffect(() => {
    if (!hidden && !loaded) send({ type: 'task.code.load' });
  }, [hidden, loaded, taskKey]);

  const repos = state?.repos ?? [];
  const shown = repos.filter(repoHasContent);
  const first = shown.flatMap((r) => r.commits.map((c) => ({ root: r.root, sha: c.sha })))[0];
  const exists = (s: Sel | undefined): s is Sel =>
    !!s && repos.some((r) => r.root === s.root && r.commits.some((c) => c.sha === s.sha));
  const cur: Sel | undefined = exists(sel) ? sel : first;
  const curRepo = cur ? repos.find((r) => r.root === cur.root) : undefined;
  const curCommit = cur ? curRepo?.commits.find((c) => c.sha === cur.sha) : undefined;
  const curFiles = cur ? taskCodeCommits.value[keyOf(cur)] : undefined;

  // файлы выбранного коммита: запрашиваем, пока ответа нет
  useEffect(() => {
    if (!hidden && cur && !curFiles) send({ type: 'task.code.commit', root: cur.root, sha: cur.sha });
  }, [hidden, cur?.root, cur?.sha, !!curFiles]);

  const gotDiff = taskCodeDiff.value;
  const body: DiffBody =
    req !== 0 && gotDiff && gotDiff.req === req ? (gotDiff.patch ?? { error: gotDiff.error ?? '' }) : 'loading';

  const ask = (set: DiffSet, i: number) => {
    const it = set.items[i];
    if (!it) return;
    const next = ++reqSeq;
    setReq(next);
    send({ type: 'task.code.diff', req: next, root: set.root, target: it.target });
  };
  const openDiff = (set: DiffSet, i = 0, sha?: string) => {
    if (set.items.length === 0) return;
    setHow(false);
    setDiff({ set, i, sha });
    ask(set, i);
  };
  const closeDiff = () => {
    setReq(0);
    setDiff(undefined);
    setFollow(undefined);
  };
  const step = (dir: 1 | -1) => {
    if (!diff) return;
    const i = stepIndex(diff.i, diff.set.items.length, dir);
    if (i === diff.i) return;
    setDiff({ ...diff, i });
    ask(diff.set, i);
  };
  const pick = (s: Sel) => {
    setSel(s);
    if (diff && !(diff.sha === s.sha && diff.set.root === s.root)) setFollow(keyOf(s));
  };

  useEffect(() => {
    if (!follow || !cur || keyOf(cur) !== follow || !curFiles || !curCommit) return;
    setFollow(undefined);
    if (curFiles.files.length > 0) openDiff(commitSet(cur.root, cur.sha, curCommit.short, curFiles.files), 0, cur.sha);
    else closeDiff();
  }, [follow, curFiles]);

  // Esc закрывает всплывашку, затем дифф; j/k — следующий/предыдущий файл набора
  useEffect(() => {
    if (hidden || (!diff && !how)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as Partial<HTMLElement> | null;
      if (typeof el?.closest === 'function' && el.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        // Esc закрывает дифф/всплывашку, а не останавливает ход (общий обработчик чата слушает window)
        e.preventDefault();
        e.stopPropagation();
        if (how) setHow(false);
        else closeDiff();
      } else if (diff && !how && (e.key === 'j' || e.key === 'k')) {
        e.preventDefault();
        step(e.key === 'j' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hidden, diff, how]);

  const nCommits = shown.reduce((n, r) => n + r.commits.length, 0);
  const nDirty = shown.reduce((n, r) => n + r.dirty.length, 0);
  const busy = !state || (!!state.loading && repos.length === 0);

  const item = diff?.set.items[diff.i];
  const lang = item ? languageFor(item.path) : null;
  const html = useMemo(() => diffBodyHtml(body, diffMode, lang), [body, diffMode, lang]);

  return (
    <div class="tcd" hidden={hidden} role="tabpanel" aria-labelledby="vtab-code" aria-label={t.aria}>
      <div class="tcd-main">
        <div class={diff ? 'lc open' : 'lc'}>
          <div class="l">
            <div class="top">
              {!busy && (
                <span>
                  {t.repos(shown.length)} · {t.commits(nCommits)} · {t.dirtyCount(nDirty)}
                </span>
              )}
              <button
                class={`rf${state?.loading ? ' busy' : ''}`}
                data-tip={t.refresh}
                aria-label={t.refresh}
                disabled={state?.loading === true}
                onClick={() => send({ type: 'task.code.load', force: true })}
              >
                ↻
              </button>
              <button class="q" onClick={() => setHow((v) => !v)} aria-expanded={how}>
                {t.how}
              </button>
            </div>
            {busy && !state?.error && <div class="note">{t.loading}</div>}
            {state?.error && <div class="note err">{state.error}</div>}
            {!busy && !state?.error && shown.length === 0 && (
              <div class="note">{repos.length === 0 ? t.noRepos : t.empty}</div>
            )}
            {shown.map((r) => (
              <RepoBlock
                key={r.root}
                repo={r}
                sel={cur}
                onPick={(sha) => pick({ root: r.root, sha })}
                onOpen={openDiff}
              />
            ))}
          </div>
          {diff && item && (
            <div class="dview" role="region" aria-label={t.diffAria}>
              <div class="dbar">
                <StatusLetter s={item.status} />
                <span class="dpath" title={item.from ? `${item.path} (${t.renamedFrom(item.from)})` : item.path}>
                  {splitPath(item.path)[0] && <span class="ddir">{splitPath(item.path)[0]}</span>}
                  <b>{splitPath(item.path)[1]}</b>
                </span>
                <Stat f={item} />
                <span class="dctx">{diff.set.label}</span>
                <span class="dctx">{t.diffFileOf(diff.i + 1, diff.set.items.length)}</span>
                <span class="dsp" />
                <button class="ib" data-tip={t.diffPrev} aria-label={t.diffPrev} disabled={diff.i === 0} onClick={() => step(-1)}>
                  ‹
                </button>
                <button
                  class="ib"
                  data-tip={t.diffNext}
                  aria-label={t.diffNext}
                  disabled={diff.i >= diff.set.items.length - 1}
                  onClick={() => step(1)}
                >
                  ›
                </button>
                <span class="seg" role="group">
                  {(['inline', 'split'] as const).map((m) => (
                    <button
                      key={m}
                      aria-pressed={diffMode === m}
                      data-tip={diffMode === m ? undefined : t.diffSwitchTo(m === 'inline' ? t.diffInline : t.diffSplit)}
                      onClick={() => onDiffMode(m)}
                    >
                      {m === 'inline' ? t.diffInline : t.diffSplit}
                    </button>
                  ))}
                </span>
                <button class="ib" data-tip={t.diffClose} aria-label={t.diffClose} onClick={closeDiff}>
                  ✕
                </button>
              </div>
              <div class="dbody" key={`${diff.set.root}:${item.path}`} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
        </div>
        <div class="r">
          {curRepo && curCommit && cur ? (
            <CommitDetails
              repo={curRepo}
              commit={curCommit}
              files={curFiles}
              active={diff?.sha === cur.sha && !follow ? diff.i : undefined}
              onDiff={(i) => openDiff(commitSet(cur.root, cur.sha, curCommit.short, curFiles?.files ?? []), i, cur.sha)}
              onToChat={() => {
                send({
                  type: 'task.code.prefill',
                  text: prefillText(curCommit.short, curCommit.subject, curRepo.name).slice(0, CODE_LIMITS.prefill),
                });
                onToChat();
              }}
            />
          ) : (
            <div class="note">{t.pickCommit}</div>
          )}
        </div>
      </div>
      {how && (
        <How
          taskKey={taskKey}
          search={state?.search ?? { message: true, branch: true }}
          onClose={() => setHow(false)}
        />
      )}
    </div>
  );
}

function RepoBlock({
  repo,
  sel,
  onPick,
  onOpen,
}: {
  repo: CodeRepo;
  sel: Sel | undefined;
  onPick: (sha: string) => void;
  onOpen: (set: DiffSet, i?: number) => void;
}) {
  const t = ui.task.code;
  const branches = visibleBranches(repo);
  const [head, ...rest] = branches;
  return (
    <div class="rb">
      <div class="rh">
        <b>{repo.name}</b>
        {head ? <BranchHead repo={repo} b={head} onOpen={onOpen} /> : <span class="br">{t.noBranch(repo.base ?? '')}</span>}
      </div>
      {rest.map((b) => (
        <div class="rh b2" key={b.name}>
          <BranchHead repo={repo} b={b} onOpen={onOpen} />
        </div>
      ))}
      {repo.error && <div class="note err">{t.repoError(repo.error)}</div>}
      {repo.commits.map((c) => {
        const on = !!sel && sel.root === repo.root && sel.sha === c.sha;
        return (
          <div key={c.sha} class={on ? 'row sel' : 'row'} aria-pressed={on} {...rowProps(() => onPick(c.sha))}>
            <span class="h">{c.short}</span>
            <span class="s" title={c.subject}>
              {c.subject}
            </span>
            <span class="who">{c.author}</span>
            <CommitTags c={c} repo={repo} />
            <span class="t" title={new Date(c.at).toLocaleString()}>
              {dateTimeLabel(c.at)}
            </span>
          </div>
        );
      })}
      {repo.dirty.length > 0 && (
        <>
          <div class="sub">{t.dirtyHead}</div>
          {repo.dirty.map((f, i) => (
            <div key={f.path} class="row f" {...rowProps(() => onOpen(dirtySet(repo.root, repo.dirty), i))}>
              <StatusLetter s={f.status} />
              <FileName f={f} />
              <ChatMarks chats={f.chats} />
              <Stat f={f} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function BranchHead({
  repo,
  b,
  onOpen,
}: {
  repo: CodeRepo;
  b: CodeBranch;
  onOpen: (set: DiffSet, i?: number) => void;
}) {
  const t = ui.task.code;
  const base = repo.base;
  return (
    <>
      <span class="br" title={b.name}>
        {base ? t.branchLine(b.name, base, b.ahead) : b.name}
      </span>
      {base && b.files.length > 0 && (
        <>
          <span class="sp" />
          <span class="n">
            <span class="add">+{b.add}</span> <span class="del">−{b.del}</span>
          </span>
          <button data-tip={t.branchDiffTitle} onClick={() => onOpen(branchSet(repo.root, base, b))}>
            {t.branchDiff}
          </button>
        </>
      )}
    </>
  );
}

function CommitDetails({
  repo,
  commit,
  files,
  active,
  onDiff,
  onToChat,
}: {
  repo: CodeRepo;
  commit: CodeCommit;
  files: { files: CodeFile[]; error?: string } | undefined;
  /** Файл, открытый сейчас в диффе. */
  active?: number;
  onDiff: (i: number) => void;
  onToChat: () => void;
}) {
  const t = ui.task.code;
  const list = files?.files ?? [];
  return (
    <>
      <h5>{t.commit}</h5>
      <div class="ttl2">{commit.subject}</div>
      <div class="meta2">
        <span class="mono">{commit.short}</span>
        <span>·</span>
        <span>{commit.author}</span>
        <span>·</span>
        <span>{dateTimeLabel(commit.at)}</span>
        <CommitTags c={commit} repo={repo} />
      </div>
      <h5>{files ? t.files(list.length) : t.filesLoading}</h5>
      {files?.error && <div class="note err">{files.error}</div>}
      {files && !files.error && list.length === 0 && <div class="note">{t.noFiles}</div>}
      {list.map((f, i) => (
        <div
          key={f.path}
          class={i === active ? 'fr on' : 'fr'}
          aria-current={i === active || undefined}
          {...rowProps(() => onDiff(i))}
        >
          <StatusLetter s={f.status} />
          <FileName f={f} />
          <Stat f={f} />
        </div>
      ))}
      <div class="acts2">
        <button class="pri" disabled={list.length === 0} onClick={() => onDiff(0)}>
          {t.commitDiff}
        </button>
        <button data-tip={t.toChatTitle} onClick={onToChat}>
          {t.toChat}
        </button>
        <button onClick={() => send({ type: 'task.code.copy', text: commit.sha })}>{t.copyHash}</button>
      </div>
    </>
  );
}

/**
 * Всплывашка «как ищем?» (решение 13): общий текст без реальных базы, ветки и репозитория. Пункты по настройкам
 * поиска (`search` — с чем собран итог): выключенный виден, но приглушён и без команд.
 */
function How({
  taskKey,
  search,
  onClose,
}: {
  taskKey: string;
  search: { message: boolean; branch: boolean };
  onClose: () => void;
}) {
  const t = ui.task.code;
  const cmd = howCommands(taskKey);
  const { key } = cmd;
  const Pre = ({ text }: { text: string }) => (
    <pre>
      {text}
      <button class="cp" onClick={() => send({ type: 'task.code.copy', text })}>
        {t.howCopy}
      </button>
    </pre>
  );
  const off = <span class="offmark">{t.howOff}</span>;
  return (
    <div class="how" role="dialog" aria-label={t.howTitle}>
      <h6>
        {t.howTitle}
        <button class="x" aria-label={t.howClose} data-tip={t.howClose} onClick={onClose}>
          ×
        </button>
      </h6>
      <p>{t.howIntro(key)}</p>
      <ol>
        <li class={search.message ? undefined : 'off'} data-rule="message">
          {t.howMessage(key)}
          {search.message ? <Pre text={cmd.log} /> : off}
        </li>
        <li class={search.branch ? undefined : 'off'} data-rule="branch">
          {t.howBranch(key)}
          {search.branch ? (
            <>
              <Pre text={cmd.branches} />
              <Pre text={cmd.ahead} />
            </>
          ) : (
            off
          )}
        </li>
      </ol>
      <p>{t.howBase}</p>
      <p>{t.howDirty}</p>
      {search.message || search.branch ? (
        <div class="rule">
          {t.howRuleLead}
          {search.message && (
            <>
              {t.howRuleMsg}
              <code>{key}: …</code>
            </>
          )}
          {search.message && search.branch && t.howRuleOr}
          {search.branch && (
            <>
              {t.howRuleBranch}
              <code>feature/{key}</code>
            </>
          )}
          {t.howRuleTail}
        </div>
      ) : (
        <p class="gitoff">{t.howGitOff}</p>
      )}
      <button class="lnk" onClick={() => send({ type: 'settings.open', section: 'integrations' })}>
        {t.howSettings}
      </button>
    </div>
  );
}
