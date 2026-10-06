/** Стор чата webview на сигналах: состояние ленты, контекст редактора, поле ввода. */
import { computed, signal } from '@preact/signals';
import type {
  AgentEvent,
  AgentProvider,
  CommandOption,
  EffortLevel,
  FileRef,
  ImageRef,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PromptFile,
  PromptImage,
} from '../agent/types';
import { providerFeatures, type ProviderFeatures } from '../agent/features';
import { attachmentKey, type Attachment, type FileHit } from '../shared/prompt';
import { imageTokens, MAX_IMAGES_PER_MESSAGE, type ImageProblem } from '../shared/images';
import {
  attachFileTokens,
  attachTokenBudget,
  fileName,
  MAX_FILES_PER_MESSAGE,
  MAX_MESSAGE_ATTACH_CHARS,
  sessionPdfPages,
  sessionProblem,
  type FileProblem,
  type SessionAttach,
} from '../shared/files';
import {
  baseName,
  extOf,
  prepareImage,
  type DraftImage,
  type ImageCodec,
  type ImageSource,
} from './imageDraft';
import type {
  EditorContext,
  LimitWindowSummary,
  QuotaRow,
  PickedFile,
  PlanChoice,
  SessionSummary,
  ToWebview,
} from '../protocol';
import {
  addRefusal,
  addSys,
  answersOf,
  applyEvent,
  attachPreview,
  initialState,
  markPermission,
  markPlan,
  markRefusalSent,
  retireRefusals,
  unmarkRefusalSent,
  markRetrying,
  unmarkRetrying,
  markQuestionSent,
  pickOption,
  queueUser,
  questionReady,
  resetSession,
  seedHistory,
  setCustomAnswer,
  type ChatState,
  type QuestionCard,
} from './chatState';
import type { AgentsView, ComposerLayout, FeedStyle, GitLayout } from '../settings';
import type { GitOp, GitSnapshot } from '../shared/git';
import { pushHistory } from './composer';
import { applyHud, contextMax, initialHud, resetHud, type HudState } from './hudState';
import { cacheView, contextFullAt, contextView, kilo, limitsView } from './hudView';
import { limitBlock, type LimitBlock } from './limitView';
import { ui } from './strings';
import { shortModel } from './toolView';
import { forgetSession, persistSession, send } from './vscode';

export const chat = signal<ChatState>(initialState());
/** Движок вкладки и его возможности (`chat.info`); нет полей в сообщении — Claude. Переживают `session.reset`. */
export const provider = signal<AgentProvider>('claude');
export const features = signal<ProviderFeatures>(providerFeatures('claude'));
/** Агрегаты приборов: контекст, кэш, итоги сессии, таймлайн хода, агенты (`hudState.ts`). */
export const hudState = signal<HudState>(initialHud());
/** Лимиты подписки от хоста (`limits.update`); `updatedAt: 0` — ещё не получены. */
export const limits = signal<{
  windows: LimitWindowSummary[];
  updatedAt: number;
  error?: string;
}>({ windows: [], updatedAt: 0 });
/** Квота Antigravity (`quota.update`): пусто — не получена или не разобрана, HUD ничего не рисует. */
export const quota = signal<{ rows: QuotaRow[]; updatedAt: number }>({ rows: [], updatedAt: 0 });
export const capabilities = signal<{ models: ModelOption[]; commands: CommandOption[] }>({
  models: [],
  commands: [],
});
export const editor = signal<EditorContext>({});
export const recent = signal<SessionSummary[]>([]);
/** Сессия активной вкладки (`sessions.update.current`) — строка `cur` в списках. */
export const currentSession = signal<string | undefined>(undefined);
/** Ключи автоконтекста, снятые крестиком. */
export const dismissed = signal<ReadonlySet<string>>(new Set());
/** Чипы, добавленные через «@»/«+». */
export const extra = signal<Attachment[]>([]);
/** Картинки в поле ввода (этап 4 roadmap 0.2): ⌘V, перетаскивание, «+». */
export const draftImages = signal<DraftImage[]>([]);
/** Файл в поле ввода (этап 8 roadmap 0.2): готов к отправке (`file`) или красная плашка (`problem`). */
export interface DraftFile {
  id: number;
  name: string;
  file?: PromptFile;
  problem?: FileProblem;
}
/** Текстовые файлы и pdf в поле ввода: «+», перетаскивание из проводника VS Code. */
export const draftFiles = signal<DraftFile[]>([]);
/**
 * Вложения в истории сессии с последней компакции (снимок хоста `session.attach`): лимиты API —
 * на запрос со всей историей, поэтому новые вложения проверяются с их учётом.
 */
export const sessionAttach = signal<SessionAttach>({ pdfPages: 0, chars: 0 });
export const autoFile = signal(true);
export const autoSelection = signal(true);
export const showThinking = signal(true);
/** Вид ленты (`agentura.feed.style`, приходит в `chat.info`): `data-feed` на корне чата. */
export const feedStyle = signal<FeedStyle>('journal');
/** Раскладка поля ввода (`agentura.composer.layout`, приходит в `chat.info`): `data-layout` на `footer.compose`. */
export const composerLayout = signal<ComposerLayout>('classic');
/** Вид вкладки «агенты» (`agentura.agents.view`, `chat.info`): `data-agents` на корне чата. */
export const agentsView = signal<AgentsView>('list');
/** Раскладка вкладки «git» при нескольких репо (`agentura.git.layout`, `chat.info`): `data-git` на корне чата. */
export const gitLayout = signal<GitLayout>('stack');
export const history = signal<string[]>([]);

/** Вкладка «git» (roadmap 12): последний снимок хоста; `undefined` — хост ещё не прислал («git загружается…»). */
export const gitSnapshot = signal<GitSnapshot | undefined>(undefined);
/** Отказ действия вкладки «git»: строка над полем коммита репозитория `root` (без `root` — над первым). */
export const gitErrors = signal<Readonly<Record<string, GitErrorView>>>({});
/** Черновики коммита по корню репозитория: переживают скрытие вкладки, но не окно. */
export const gitDrafts = signal<Readonly<Record<string, GitDraft>>>({});

export interface GitErrorView {
  op: GitOp;
  message: string;
}

export interface GitDraft {
  summary: string;
  desc: string;
  amend: boolean;
  push: boolean;
}

export const EMPTY_DRAFT: GitDraft = { summary: '', desc: '', amend: false, push: false };

/** Ключ ошибки без репозитория. */
export const GIT_ANY = '';
/** Ключ общего черновика раскладки `unified` (не корень репозитория — при чистке исчезнувших репо не трогается). */
export const GIT_UNIFIED = '*';
/** Чипы целей коммита раскладки `unified`: явный выбор по корню; нет записи — отмечен. */
export const gitTargets = signal<Readonly<Record<string, boolean>>>({});
/** Репозитории, куда последний коммит из `unified` прошёл (строка успеха над полем); пусто — нет. */
export const gitCommitted = signal<readonly string[]>([]);
/** ✦ ждёт ответа: ключ черновика (корень или `GIT_UNIFIED`) → `roots` запроса `git.message`. */
export const gitGenerating = signal<Readonly<Record<string, readonly string[]>>>({});

const sameRoots = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((r) => b.includes(r));

/**
 * ✦: попросить сообщение коммита по индексу `roots` в черновик `key`. Уже ждёт — ничего (повторный клик).
 * Ответ (`git.message.result`) заменяет заголовок и описание черновика целиком.
 */
export function requestGitMessage(key: string, roots: readonly string[]): boolean {
  if (key in gitGenerating.value || roots.length === 0) return false;
  gitGenerating.value = { ...gitGenerating.value, [key]: [...roots] };
  for (const r of roots) clearGitError(r);
  if (key === GIT_UNIFIED) clearGitError(GIT_ANY);
  send({ type: 'git.message', roots: [...roots] });
  return true;
}

/** Снять ожидание ✦ с черновиков, чьи `roots` подходят под `match`. */
function settleGenerating(match: (roots: readonly string[]) => boolean): string[] {
  const keys = Object.entries(gitGenerating.value)
    .filter(([, roots]) => match(roots))
    .map(([k]) => k);
  if (keys.length) {
    const rest = { ...gitGenerating.value };
    for (const k of keys) delete rest[k];
    gitGenerating.value = rest;
  }
  return keys;
}

export function setGitTarget(root: string, on: boolean): void {
  gitTargets.value = { ...gitTargets.value, [root]: on };
}

export function setGitDraft(root: string, patch: Partial<GitDraft>): void {
  gitDrafts.value = {
    ...gitDrafts.value,
    [root]: { ...EMPTY_DRAFT, ...gitDrafts.value[root], ...patch },
  };
}

export function clearGitError(root: string): void {
  if (!(root in gitErrors.value) && !(GIT_ANY in gitErrors.value)) return;
  const rest = { ...gitErrors.value };
  delete rest[root];
  delete rest[GIT_ANY];
  gitErrors.value = rest;
}
export const fileHits = signal<{ requestId: number; items: FileHit[] }>({
  requestId: 0,
  items: [],
});
/**
 * Куда уйдёт следующий текст поля ввода (этап 5): свой ответ на вопрос агента или доработка
 * плана — вместо сообщения агенту.
 */
export type ReplyTarget =
  { kind: 'question'; toolUseId: string; question: string } | { kind: 'plan'; toolUseId: string };
export const replyTarget = signal<ReplyTarget | undefined>(undefined);

/** Тик раз в секунду, пока идёт ход: таймеры в ленте. */
export const tick = signal(Date.now());

/** Сброс окна подписки, блокировку по которому человек снял «Попробовать снова» (данные могли устареть). */
const limitDismissed = signal<number | undefined>(undefined);

/**
 * Отправка заблокирована лимитом (этап 7): своя сессия упёрлась или окно подписки на 100 % со сбросом в
 * будущем — общий на аккаунт `limits.update` доходит до всех вкладок. Пересчитывается секундным тиком.
 */
export const limitBlocked = computed<LimitBlock | undefined>(() =>
  // лимиты подписки Claude не касаются других движков: Codex-вкладку они не блокируют
  !features.value.metrics
    ? undefined
    : limitBlock(
        {
          status: chat.value.status,
          resetsAt: chat.value.limitResetsAt,
          windows: limits.value.windows,
          dismissed: limitDismissed.value,
        },
        tick.value,
      ),
);

/** Значения приборов у поля ввода: пересчитываются по событиям и по секундному тику. */
export const meters = computed(() => {
  const now = tick.value;
  const h = hudState.value;
  return {
    context: contextView(h),
    cache: cacheView(h, now),
    limits: limitsView(limits.value.windows, now),
  };
});

/**
 * Сессия, которую webview уже бросил (`session.new`/`session.reset`): её события, успевшие уйти
 * от хоста до закрытия, не должны попасть в ленту и приборы новой.
 */
let abandonedSessionId: string | undefined;

function abandonSession(): void {
  if (chat.value.sessionId) abandonedSessionId = chat.value.sessionId;
  forgetSession();
}

export function handleHostMessage(m: ToWebview): void {
  switch (m.type) {
    case 'agent.event':
      if (abandonedSessionId !== undefined && m.sessionId === abandonedSessionId) break;
      // новая сессия поднялась — фильтр больше не нужен; возобновление той же сессии снимает его на
      // `session.history` (иначе её `init` отфильтровался бы как событие брошенной)
      if (m.event.type === 'session.init') {
        abandonedSessionId = undefined;
        persistSession(m.event.sessionId, provider.value);
      }
      dispatchEvent(m.event);
      break;
    case 'session.history': {
      // хост шлёт историю строго после всех событий прежней сессии: брошенных «хвостов» больше не будет
      abandonedSessionId = undefined;
      replyTarget.value = undefined;
      extra.value = [];
      const now = Date.now();
      chat.value = seedHistory(chat.value, m, m.events, now);
      selectedAgent.value = undefined;
      let hud = resetHud(hudState.value);
      for (const e of m.events) hud = applyHud(hud, e, now);
      hudState.value = hud;
      persistSession(m.sessionId, provider.value);
      break;
    }
    case 'chat.command':
      if (m.name === 'status') showStatus();
      break;
    case 'agy.retryRejected':
      chat.value = addSys(unmarkRefusalSent(chat.value), [ui.cards.refusal.rejected], 'bad');
      break;
    case 'session.defaults': {
      // новая сессия: режим и effort из настроек (до `session.init`, который придёт после первого хода)
      const next = { ...chat.value, mode: m.mode };
      if (m.effort) next.effort = m.effort;
      else delete next.effort;
      chat.value = next;
      break;
    }
    case 'chat.info':
      // другой движок — другие модели и команды: прежний список не показываем, пока не придут новые
      if ((m.provider ?? 'claude') !== provider.value)
        capabilities.value = { models: [], commands: [] };
      provider.value = m.provider ?? 'claude';
      features.value = m.features ?? providerFeatures(provider.value);
      // файл прикрепили до смены движка: новый файлов не принимает — плашка, а не молча потерянное вложение
      if (!features.value.files && draftFiles.value.some((d) => d.file))
        draftFiles.value = draftFiles.value.map((d) =>
          d.file ? { id: d.id, name: d.name, problem: 'engine' } : d,
        );
      chat.value = { ...chat.value, project: m.project, cwd: m.cwd, allowBypass: m.allowBypass };
      feedStyle.value = m.feedStyle ?? 'journal';
      composerLayout.value = m.composerLayout ?? 'classic';
      agentsView.value = m.agentsView ?? 'list';
      gitLayout.value = m.gitLayout ?? 'stack';
      if (m.contextThresholds?.length) {
        hudState.value = { ...hudState.value, thresholds: [...m.contextThresholds] };
      }
      break;
    case 'limits.update':
      limits.value = {
        // ошибка опроса без окон не стирает прежние проценты
        windows: m.windows.length || !m.error ? m.windows : limits.value.windows,
        updatedAt: m.updatedAt,
        ...(m.error ? { error: m.error } : {}),
      };
      break;
    case 'quota.update':
      quota.value = { rows: m.rows, updatedAt: m.updatedAt };
      break;
    case 'capabilities':
      capabilities.value = { models: m.models, commands: m.commands };
      break;
    case 'editor.context':
      editor.value = {
        ...(m.file ? { file: m.file } : {}),
        ...(m.selection ? { selection: m.selection } : {}),
      };
      break;
    case 'files.result':
      // ответы на поиск могут прийти не по порядку — устаревший не затирает свежий
      if (m.requestId >= fileHits.value.requestId) {
        fileHits.value = { requestId: m.requestId, items: m.items };
      }
      break;
    case 'attach.picked':
      for (const hit of m.items) addExtra({ kind: hit.isDir ? 'folder' : 'file', path: hit.path });
      break;
    case 'file.picked':
      addFiles(m.items);
      break;
    case 'image.picked':
      void addImages(
        m.items.map((i) =>
          i.problem
            ? {
                name: i.name,
                ...(i.mediaType ? { mediaType: i.mediaType } : {}),
                problem: i.problem,
              }
            : {
                name: i.name,
                ...(i.mediaType ? { mediaType: i.mediaType } : {}),
                data: i.data ?? '',
              },
        ),
      );
      break;
    case 'sessions.update':
      recent.value = m.sessions;
      currentSession.value = m.current;
      break;
    case 'diff.preview':
      if (abandonedSessionId !== undefined && m.sessionId === abandonedSessionId) break;
      chat.value = attachPreview(chat.value, m.toolUseId, m.preview);
      break;
    case 'session.attach':
      sessionAttach.value = { pdfPages: m.pdfPages, chars: m.chars };
      break;
    case 'session.reset':
      sessionAttach.value = { pdfPages: 0, chars: 0 };
      abandonSession();
      replyTarget.value = undefined;
      chat.value = resetSession(chat.value);
      hudState.value = resetHud(hudState.value);
      selectedAgent.value = undefined;
      extra.value = [];
      break;
    case 'git.state': {
      gitSnapshot.value = m.snapshot;
      // репозиторий исчез — его черновик и ошибка больше не нужны
      const roots = new Set(m.snapshot.repos.map((r) => r.root));
      const drafts = Object.keys(gitDrafts.value).filter((r) => r !== GIT_UNIFIED && !roots.has(r));
      if (drafts.length) {
        gitDrafts.value = Object.fromEntries(
          Object.entries(gitDrafts.value).filter(([r]) => r === GIT_UNIFIED || roots.has(r)),
        );
      }
      break;
    }
    case 'git.error':
      // отказ ✦: `root` есть, только если запрос был по одному репозиторию
      if (m.op === 'message') {
        const root = m.root;
        settleGenerating((roots) =>
          root === undefined ? roots.length > 1 : sameRoots(roots, [root]),
        );
      }
      gitErrors.value = {
        ...gitErrors.value,
        [m.root ?? GIT_ANY]: { op: m.op, message: m.message },
      };
      break;
    case 'git.commit.result':
      // удачный коммит: черновик репозитория сброшен (push остаётся — выбор пользователя), ошибка снята
      for (const r of m.results) {
        if (!r.ok) continue;
        const d = gitDrafts.value[r.root];
        if (d) setGitDraft(r.root, { summary: '', desc: '', amend: false });
        clearGitError(r.root);
      }
      // общий черновик `unified` сбрасываем, только если прошли все; иначе сообщение остаётся для повтора
      if (m.results.length > 0 && m.results.every((r) => r.ok)) {
        if (gitDrafts.value[GIT_UNIFIED])
          setGitDraft(GIT_UNIFIED, { summary: '', desc: '', amend: false });
      }
      gitCommitted.value = m.results.filter((r) => r.ok).map((r) => r.root);
      break;
    case 'git.message.result':
      for (const key of settleGenerating((roots) => sameRoots(roots, m.roots)))
        setGitDraft(key, { summary: m.summary, desc: m.desc });
      break;
    default:
      break;
  }
}

export function dispatchEvent(event: AgentEvent, now = Date.now()): void {
  chat.value = applyEvent(chat.value, event, now);
  // Antigravity без подтверждений по действию: отказ режима — карточка с повтором; в «всё разрешено» отказывать нечему,
  // после Stop повторять нечего. Следующий ход (повтор, новое сообщение) карточку закрывает
  if (event.type === 'turn.start' && !event.agentId) chat.value = retireRefusals(chat.value);
  if (
    event.type === 'turn.result' &&
    !event.agentId &&
    !event.interrupted &&
    provider.value === 'antigravity' &&
    chat.value.mode !== 'bypassPermissions'
  ) {
    chat.value = addRefusal(chat.value, event.permissionDenials);
  }
  // карточка, которой адресован ответ из поля, закрыта (ответ, отмена движком) — поле снова обычное
  const t = replyTarget.value;
  if (t && event.type === 'permission.resolved' && event.toolUseId === t.toolUseId) {
    replyTarget.value = undefined;
  }
  const before = hudState.value;
  hudState.value = applyHud(before, event, now);
  noteThreshold(before, hudState.value, event);
  // лимит от движка — запас, пока хост не прислал данные `/api/oauth/usage`
  if (event.type === 'limit.update' && !event.agentId && limits.value.updatedAt === 0) {
    limits.value = { windows: event.windows, updatedAt: now };
  }
}

/**
 * Контекст перешагнул последний порог (с кнопкой «сжать» в HUD): системная строка в ленте, как в
 * прототипе (`limit.html`). Раз на пересечение: после сжатия и нового роста — снова.
 */
function noteThreshold(before: HudState, after: HudState, event: AgentEvent): void {
  // «сжать» у Codex нет: строка про порог и автосжатие была бы фальшивой
  if (event.type !== 'context.usage' || event.agentId || !features.value.compact) return;
  const top = Math.max(0, ...after.thresholds);
  const was = before.context?.used ?? 0;
  const used = after.context?.used ?? 0;
  if (top <= 0 || was >= top || used < top) return;
  const fullAt = contextFullAt(after.context?.autoCompact, contextMax(after));
  chat.value = addSys(chat.value, [ui.sys.contextPassed(kilo(used), kilo(top), kilo(fullAt))]);
}

/** `/status` — строка в ленту: модель, режим, папка (из поля ввода и из боковой панели). */
export function showStatus(): void {
  const st = chat.value;
  chat.value = addSys(st, [
    ui.sys.status(
      st.model ? shortModel(st.model) : '—',
      features.value.modes ? (ui.modes[st.mode]?.[0] ?? st.mode) : undefined,
      st.cwd,
    ),
  ]);
}

export function compact(): void {
  send({ type: 'compact', sessionId: chat.value.sessionId });
}

export function stopAgent(taskId: string): void {
  send({ type: 'agent.stop', sessionId: chat.value.sessionId, taskId });
}

/** Агент, открытый в деталях вкладки «агенты» (`agentId` — id вызова `Agent`). */
export const selectedAgent = signal<string | undefined>(undefined);

/** «stop all» в живой строке, пока основной ждёт агентов: `stopTask` по каждому живому. */
export function stopAgents(taskIds: readonly string[]): void {
  for (const taskId of taskIds) stopAgent(taskId);
}

/** Транскрипт субагента — документом только для чтения в редакторе (хост читает его с диска). */
export function openAgentTranscript(agentId: string, taskId: string): void {
  send({ type: 'agent.transcript', sessionId: chat.value.sessionId, agentId, taskId });
}

export function addExtra(a: Attachment): void {
  if (extra.value.some((x) => attachmentKey(x) === attachmentKey(a))) return;
  extra.value = [...extra.value, a];
}

export function removeExtra(key: string): void {
  extra.value = extra.value.filter((x) => attachmentKey(x) !== key);
}

export function dismiss(key: string): void {
  dismissed.value = new Set([...dismissed.value, key]);
}

/** Автоконтекст в виде вложений: открытый файл и выделение минус снятое и выключенное. */
export function autoAttachments(
  ctx: EditorContext,
  flags: { file: boolean; selection: boolean },
  skip: ReadonlySet<string>,
): Attachment[] {
  const out: Attachment[] = [];
  if (flags.file && ctx.file) out.push({ kind: 'file', path: ctx.file.path });
  if (flags.selection && ctx.selection) {
    out.push({
      kind: 'selection',
      path: ctx.selection.path,
      startLine: ctx.selection.startLine,
      endLine: ctx.selection.endLine,
    });
  }
  return out.filter((a) => !skip.has(attachmentKey(a)));
}

export function currentAttachments(): Attachment[] {
  const auto = autoAttachments(
    editor.value,
    { file: autoFile.value, selection: autoSelection.value },
    dismissed.value,
  );
  const autoKeys = new Set(auto.map(attachmentKey));
  return [...auto, ...extra.value.filter((x) => !autoKeys.has(attachmentKey(x)))];
}

/** Вложения, которые уйдут в этом сообщении, — в счёт сессии (оптимистично, до снимка хоста). */
function noteSentAttach(images: readonly PromptImage[], files: readonly PromptFile[]): void {
  const chars =
    images.reduce((sum, i) => sum + i.data.length, 0) +
    files.reduce((sum, f) => sum + f.data.length, 0);
  if (chars === 0) return;
  const pages = files.reduce((sum, f) => sum + sessionPdfPages(f), 0);
  const a = sessionAttach.value;
  sessionAttach.value = { pdfPages: a.pdfPages + pages, chars: a.chars + chars };
}

/** Вложения, уже лежащие в поле ввода (без уменьшающихся и плашек), кроме `skip`. */
function draftAttach(skipImage?: number): SessionAttach & { tokens: number } {
  let chars = 0;
  let pdfPages = 0;
  let tokens = 0;
  for (const d of draftImages.value) {
    if (!d.image || d.id === skipImage) continue;
    chars += d.image.data.length;
    if (d.image.width && d.image.height) tokens += imageTokens(d.image.width, d.image.height);
  }
  for (const d of draftFiles.value) {
    if (!d.file) continue;
    chars += d.file.data.length;
    pdfPages += sessionPdfPages(d.file);
    tokens += attachFileTokens(d.file);
  }
  return { chars, pdfPages, tokens };
}

/** Сколько токенов окна вложения одного сообщения могут занять: 70 % свободного места. */
function attachBudget(): number {
  const h = hudState.value;
  return attachTokenBudget(contextMax(h), h.context?.used);
}

let imageSeq = 0;
/** Сквозной номер «скриншот N» в пределах вкладки (как в прототипе: 1, 2 в ленте, 3 в поле). */
let screenshotNo = 0;

/**
 * Добавить картинки в поле ввода: плашка «уменьшаю…» сразу, затем готовая миниатюра или ошибка.
 * Сверх `MAX_IMAGES_PER_MESSAGE` — плашка ошибки «не больше 10».
 */
export async function addImages(
  sources: readonly (ImageSource & { problem?: ImageProblem })[],
  codec?: ImageCodec,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const src of sources) {
    const id = ++imageSeq;
    const clip = !src.name || /^image\.(png|jpe?g|gif|webp)$/i.test(src.name);
    const name = clip ? ui.compose.imageName(++screenshotNo) : baseName(src.name);
    const ready = draftImages.value.filter((d) => !d.problem).length;
    const problem: ImageProblem | undefined =
      src.problem ?? (ready >= MAX_IMAGES_PER_MESSAGE ? 'count' : undefined);
    if (problem) {
      draftImages.value = [
        ...draftImages.value,
        { id, name, problem, ext: extOf(src.name, src.mediaType) },
      ];
      continue;
    }
    draftImages.value = [...draftImages.value, { id, name, busy: true }];
    jobs.push(
      prepareImage(src, codec).then((r) => {
        // убрали, пока уменьшалась, — не воскрешать
        if (!draftImages.value.some((d) => d.id === id)) return;
        const others =
          draftImages.value.reduce(
            (sum, d) => sum + (d.id !== id && d.image ? d.image.data.length : 0),
            0,
          ) + filesChars();
        if (!('problem' in r) && others + r.image.data.length > MAX_MESSAGE_ATTACH_CHARS) {
          r = { problem: 'total' };
        }
        if (!('problem' in r)) {
          const draft = draftAttach(id);
          const sess = sessionAttach.value;
          const tokens =
            r.image.width && r.image.height ? imageTokens(r.image.width, r.image.height) : 0;
          const over = sessionProblem(
            { pdfPages: sess.pdfPages + draft.pdfPages, chars: sess.chars + draft.chars },
            { chars: r.image.data.length },
          );
          if (over) r = { problem: over === 'sessionPages' ? 'session' : over };
          else if (draft.tokens + tokens > attachBudget()) r = { problem: 'context' };
        }
        const next: DraftImage =
          'problem' in r
            ? { id, name, problem: r.problem, ext: extOf(src.name, src.mediaType) }
            : {
                id,
                name,
                image: { ...r.image, name },
                ...(r.original ? { original: r.original } : {}),
              };
        draftImages.value = draftImages.value.map((d) => (d.id === id ? next : d));
      }),
    );
  }
  await Promise.all(jobs);
}

export function removeImage(id: number): void {
  draftImages.value = draftImages.value.filter((d) => d.id !== id);
}

/** Готовые картинки поля ввода (без плашек ошибок и ещё уменьшающихся). */
export function readyImages(): PromptImage[] {
  return draftImages.value.flatMap((d) => (d.image ? [d.image] : []));
}

/** Картинка ещё уменьшается — отправка подождёт. */
export const imagesBusy = computed(() => draftImages.value.some((d) => d.busy));

let fileSeq = 0;

/** Символов данных у готовых файлов поля (общий лимит сообщения с картинками). */
function filesChars(): number {
  return draftFiles.value.reduce((sum, d) => sum + (d.file?.data.length ?? 0), 0);
}

/**
 * Добавить файлы в поле ввода (этап 8 roadmap 0.2): готовый — чип, отказ хоста или сверх лимитов
 * сообщения (10 файлов, 20 МБ вместе с картинками) — красная плашка. Тот же файл с тем же
 * содержимым второй раз не добавляется.
 */
export function addFiles(items: readonly PickedFile[]): void {
  // движок без вложений-файлов (Codex): красная плашка вместо молча потерянного файла
  if (!features.value.files) {
    items = items.map((it) => ({
      name: it.name || (it.path ? fileName(it.path) : 'file'),
      problem: 'engine',
    }));
  }
  for (const it of items) {
    const id = ++fileSeq;
    const name = it.name || (it.path ? fileName(it.path) : 'file');
    if (it.problem || !it.kind || !it.path || typeof it.data !== 'string') {
      draftFiles.value = [...draftFiles.value, { id, name, problem: it.problem ?? 'read' }];
      continue;
    }
    const same = draftFiles.value.some((d) => d.file?.path === it.path && d.file?.data === it.data);
    if (same) continue;
    const ready = draftFiles.value.filter((d) => d.file).length;
    const images = draftImages.value.reduce((sum, d) => sum + (d.image?.data.length ?? 0), 0);
    const problem: FileProblem | undefined =
      ready >= MAX_FILES_PER_MESSAGE
        ? 'count'
        : images + filesChars() + it.data.length > MAX_MESSAGE_ATTACH_CHARS
          ? 'total'
          : undefined;
    const file: PromptFile = {
      kind: it.kind,
      path: it.path,
      data: it.data,
      size: it.size ?? it.data.length,
      ...(it.pages !== undefined ? { pages: it.pages } : {}),
    };
    // лимиты API — на запрос со всей историей сессии, а вложения в окне — не больше 70 % свободного
    const draft = draftAttach();
    const sess = sessionAttach.value;
    const final: FileProblem | undefined =
      problem ??
      sessionProblem(
        { pdfPages: sess.pdfPages + draft.pdfPages, chars: sess.chars + draft.chars },
        { pages: sessionPdfPages(file), chars: file.data.length },
      ) ??
      (draft.tokens + attachFileTokens(file) > attachBudget() ? 'context' : undefined);
    if (final) {
      draftFiles.value = [...draftFiles.value, { id, name, problem: final }];
      continue;
    }
    draftFiles.value = [...draftFiles.value, { id, name, file }];
  }
}

/** Плашки «не взяли» без запроса к хосту (перетащили не картинку не из VS Code). */
export function rejectFiles(names: readonly string[], problem: FileProblem): void {
  addFiles(names.map((name) => ({ name, problem })));
}

export function removeFile(id: number): void {
  draftFiles.value = draftFiles.value.filter((d) => d.id !== id);
}

/** Готовые файлы поля ввода (без плашек ошибок). */
export function readyFiles(): PromptFile[] {
  return draftFiles.value.flatMap((d) => (d.file ? [d.file] : []));
}

/** Чип файла в ленте → вкладка редактора: файл рабочей папки или временная копия на хосте. */
export function openFile(f: FileRef): void {
  send({
    type: 'file.open',
    kind: f.kind,
    path: f.path,
    ...(f.data ? { data: f.data } : {}),
  });
}

/** Миниатюра в ленте → вкладка редактора (хост пишет временный файл в storage расширения). */
export function openImage(i: ImageRef): void {
  if (!i.data || !i.mediaType) return;
  send({ type: 'image.open', mediaType: i.mediaType, data: i.data });
}

export function sendMessage(text: string, withContext = true): boolean {
  const s = chat.value;
  if (s.closed || imagesBusy.value) return false;
  const attachments = withContext ? currentAttachments() : [];
  // `/команда` картинки и файлы не забирает: с content-массивом CLI не распознал бы команду
  const command = text.startsWith('/');
  const images = command ? [] : readyImages();
  const files = command ? [] : readyFiles();
  if (!text && images.length === 0 && files.length === 0) return false;
  chat.value = queueUser(s, text, images, files);
  if (text) history.value = pushHistory(history.value, text);
  extra.value = [];
  // отправленные и плашки ошибок уходят из поля вместе с текстом
  if (!command) {
    draftImages.value = [];
    draftFiles.value = [];
  }
  // хост пришлёт точный снимок; до него следующее сообщение уже проверяется с этим
  noteSentAttach(images, files);
  send({
    type: 'send',
    sessionId: s.sessionId,
    text,
    ...(attachments.length ? { attachments } : {}),
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
  });
  return true;
}

export function interrupt(): void {
  send({ type: 'interrupt', sessionId: chat.value.sessionId });
}

export function setMode(mode: PermissionMode): void {
  chat.value = { ...chat.value, mode };
  send({ type: 'mode.set', sessionId: chat.value.sessionId, mode });
}

export function setModel(model: string): void {
  chat.value = { ...chat.value, model };
  send({ type: 'model.set', sessionId: chat.value.sessionId, model });
}

export function setEffort(effort: EffortLevel): void {
  chat.value = { ...chat.value, effort };
  send({ type: 'effort.set', sessionId: chat.value.sessionId, effort });
}

function questionCard(toolUseId: string): QuestionCard | undefined {
  return chat.value.rows.find(
    (r): r is QuestionCard => r.kind === 'question' && r.toolUseId === toolUseId,
  );
}

/** Кнопка карточки разрешения. */
export function respondPermission(toolUseId: string, decision: PermissionDecision): void {
  const card = chat.value.rows.find((r) => r.kind === 'perm' && r.toolUseId === toolUseId);
  if (!card || (card.kind === 'perm' && card.sent)) return;
  chat.value = markPermission(chat.value, toolUseId, decision);
  send({ type: 'permission.respond', sessionId: chat.value.sessionId, toolUseId, decision });
}

/** Вариант ответа: один вопрос с одним выбором — ответ уходит сразу, иначе — кнопка «Ответить». */
export function chooseOption(toolUseId: string, question: string, label: string): void {
  chat.value = pickOption(chat.value, toolUseId, question, label);
  const t = replyTarget.value;
  if (t?.kind === 'question' && t.toolUseId === toolUseId && t.question === question) {
    replyTarget.value = undefined;
  }
  const card = questionCard(toolUseId);
  if (card && card.questions.length === 1 && !card.questions[0]!.multiSelect) {
    submitQuestion(toolUseId);
  }
}

/** «Свой вариант»: следующий текст поля ввода станет ответом на этот вопрос. */
export function replyToQuestion(toolUseId: string, question: string): void {
  replyTarget.value = { kind: 'question', toolUseId, question };
}

export function submitQuestion(toolUseId: string): void {
  const card = questionCard(toolUseId);
  if (!card || card.state !== 'pending' || !questionReady(card)) return;
  const answers = answersOf(card);
  chat.value = markQuestionSent(chat.value, toolUseId);
  if (replyTarget.value?.toolUseId === toolUseId) replyTarget.value = undefined;
  send({ type: 'question.answer', sessionId: chat.value.sessionId, toolUseId, answers });
}

/** Esc / «Отклонить» на вопросе: отказ, модель продолжит без ответа. */
export function declineQuestion(toolUseId: string): void {
  const card = questionCard(toolUseId);
  if (!card || card.state !== 'pending') return;
  chat.value = markQuestionSent(chat.value, toolUseId);
  if (replyTarget.value?.toolUseId === toolUseId) replyTarget.value = undefined;
  send({
    type: 'permission.respond',
    sessionId: chat.value.sessionId,
    toolUseId,
    decision: 'deny',
  });
}

/** Кнопка плана. «Доработать» без текста — ждём его из поля ввода. */
export function decidePlan(toolUseId: string, choice: PlanChoice, feedback?: string): void {
  const card = chat.value.rows.find((r) => r.kind === 'plan' && r.toolUseId === toolUseId);
  if (!card || card.kind !== 'plan' || card.state !== 'pending') return;
  const text = feedback?.trim();
  if (choice === 'refine' && !text) {
    replyTarget.value = { kind: 'plan', toolUseId };
    return;
  }
  chat.value = markPlan(chat.value, toolUseId, choice, text);
  if (replyTarget.value?.toolUseId === toolUseId) replyTarget.value = undefined;
  send({
    type: 'plan.decide',
    sessionId: chat.value.sessionId,
    toolUseId,
    decision: choice,
    ...(choice === 'refine' && text ? { feedback: text } : {}),
  });
}

/** Текст поля ввода при `replyTarget`: ответ карточке вместо сообщения. `false` — цели нет. */
export function submitReply(text: string): boolean {
  const t = replyTarget.value;
  if (!t) return false;
  if (t.kind === 'plan') {
    decidePlan(t.toolUseId, 'refine', text);
    return true;
  }
  chat.value = setCustomAnswer(chat.value, t.toolUseId, t.question, text);
  replyTarget.value = undefined;
  const card = questionCard(t.toolUseId);
  if (card && card.questions.length === 1) submitQuestion(t.toolUseId);
  return true;
}

/** Карточка отказа Antigravity: повторить ход в режиме «правки» или «всё» (хост пересоздаёт процесс agy). */
export function retryRefusal(mode: 'acceptEdits' | 'bypassPermissions'): void {
  chat.value = markRefusalSent(chat.value);
  send({ type: 'agy.retry', sessionId: chat.value.sessionId, mode });
}

/** «Повторить ход» на карточке ошибки: хост возобновляет сессию и отправляет промпт ещё раз. */
export function retryTurn(): void {
  const card = [...chat.value.rows].reverse().find((r) => r.kind === 'fail' && r.state === 'open');
  const turn = card?.kind === 'fail' && card.turn;
  chat.value = markRetrying(chat.value);
  send({ type: 'turn.retry', sessionId: chat.value.sessionId, turn });
  // хост мог молча пропустить повтор — карточка не должна висеть в «повторяю…» вечно
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    chat.value = unmarkRetrying(chat.value);
  }, RETRY_TIMEOUT_MS);
}

/** Сколько ждём начала хода после «Повторить», прежде чем вернуть кнопки (resume + старт движка). */
export const RETRY_TIMEOUT_MS = 20_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function showLog(): void {
  send({ type: 'log.show' });
}

/**
 * «Попробовать снова» в баннере лимита: блокировка по своему ходу снимается (лимит мог сброситься,
 * время сброса хост не знал), блокировка по данным подписки — для этого сброса окна (данные могли
 * устареть, или расход докуплен). Не так — движок откажет и блокировка вернётся по его ответу.
 */
export function releaseLimit(): void {
  const b = limitBlocked.value;
  if (b?.soft && b.until !== undefined) limitDismissed.value = b.until;
  const { limitResetsAt: _l, ...rest } = chat.value;
  void _l;
  chat.value = rest.status === 'limited' ? { ...rest, status: 'idle' } : rest;
  send({ type: 'limits.refresh' });
}

export function newSession(): void {
  replyTarget.value = undefined;
  sessionAttach.value = { pdfPages: 0, chars: 0 };
  abandonSession();
  chat.value = resetSession(chat.value);
  hudState.value = resetHud(hudState.value);
  extra.value = [];
  send({ type: 'session.new' });
}
