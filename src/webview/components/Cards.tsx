/** Карточки `.ask` (этап 5): разрешение (команда, правка), вопрос агента, план. Экраны permission, diff, plan. */
import { useMemo } from 'preact/hooks';
import type { PermCard, PlanCard, QuestionCard } from '../chatState';
import { alwaysButton, planView } from '../cardView';
import { onCodeCopyClick, renderMarkdown } from '../markdown';
import {
  chooseOption,
  decidePlan,
  declineQuestion,
  replyTarget,
  replyToQuestion,
  respondPermission,
  submitQuestion,
} from '../store';
import { ui } from '../strings';
import { relPath, toolView } from '../toolView';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

function Tag({ mode, agentId, text }: { mode?: string; agentId?: string; text?: string }) {
  const parts = [
    text ?? (mode ? ui.cards.modeTag(mode) : undefined),
    agentId ? ui.cards.subagent : undefined,
  ];
  return <span class="tag">{parts.filter(Boolean).join(' · ')}</span>;
}

function Hunks({ c }: { c: PermCard }) {
  const p = c.preview;
  if (!p) return <p class="dim">{ui.cards.previewLoading}</p>;
  return (
    <>
      {p.hunks.length > 0 && (
        <div class="hunk">
          {p.hunks.map((h) => (
            <>
              <div class="c">{h.header}</div>
              {h.lines.map((l) => (
                <div class={l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : undefined}>{l}</div>
              ))}
            </>
          ))}
          {p.hidden > 0 && <div class="c">{ui.cards.moreLines(p.hidden)}</div>}
        </div>
      )}
      <p class="dim" style={{ marginTop: '6px' }}>
        {p.note === 'fragment'
          ? ui.cards.fragmentNote
          : p.note === 'too-large'
            ? ui.cards.tooLarge
            : ui.cards.diffNote}
      </p>
    </>
  );
}

export function PermissionCard({
  c,
  cwd,
  mode,
  active,
  onDiff,
}: {
  c: PermCard;
  cwd: string;
  mode: string;
  active: boolean;
  onDiff: (toolUseId: string) => void;
}) {
  const edit = EDIT_TOOLS.has(c.toolName) && !!c.diff;
  const sent = !!c.sent;
  const always = edit ? undefined : alwaysButton(c.always);
  const cmd = typeof c.input['command'] === 'string' ? (c.input['command'] as string) : undefined;
  const desc =
    typeof c.input['description'] === 'string' ? (c.input['description'] as string) : undefined;
  const v = toolView(c.toolName, c.input, cwd);
  const counts = c.preview;
  const dimNotes = [
    !edit && !cmd ? c.description : undefined,
    cmd ? desc : undefined,
    c.reason && c.reason !== 'This command requires approval' ? c.reason : undefined,
    c.blockedPath ? ui.cards.blocked(relPath(c.blockedPath, cwd)) : undefined,
    cmd ? ui.cards.workdir(cwd.split('/').pop() || cwd) : undefined,
  ].filter(Boolean);
  return (
    <div class={edit ? 'ask warn' : c.toolName === 'Bash' ? 'ask warn' : 'ask'}>
      <div class="h">
        {ui.cards.permTitle(c.toolName)}
        <Tag mode={mode} {...(c.agentId ? { agentId: c.agentId } : {})} />
      </div>
      <div class="bd">
        {edit ? (
          <>
            <div class="diffbox">
              <span class="f">{relPath(c.diff!.filePath, cwd)}</span>
              <span class="st">
                {counts?.isNew && <>{ui.cards.newFile} · </>}
                {counts && (
                  <>
                    <span class="add">+{counts.add}</span> <span class="del">−{counts.del}</span>{' '}
                    ·{' '}
                  </>
                )}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onDiff(c.toolUseId);
                  }}
                >
                  {ui.cards.openDiff}
                </a>
              </span>
            </div>
            <Hunks c={c} />
          </>
        ) : (
          <pre>{cmd ?? `${v.op} ${v.what}`.trim()}</pre>
        )}
        {dimNotes.length > 0 && <p class="dim">{dimNotes.join(' · ')}</p>}
      </div>
      <div class="acts">
        {sent ? (
          <span class="hint" style={{ marginLeft: 0 }}>
            {ui.cards.sent}
          </span>
        ) : (
          <>
            <button class="btn pri" onClick={() => respondPermission(c.toolUseId, 'allow')}>
              {edit ? ui.cards.acceptEdit : ui.cards.allow}
              {active && <kbd>{ui.cards.enter}</kbd>}
            </button>
            {edit ? (
              <button class="btn" onClick={() => respondPermission(c.toolUseId, 'allow-edits')}>
                {ui.cards.acceptEditsSession}
              </button>
            ) : (
              always && (
                <button class="btn" onClick={() => respondPermission(c.toolUseId, 'allow-always')}>
                  {always.label}
                  {always.code && (
                    <>
                      {' '}
                      <code>{always.code}</code>
                    </>
                  )}
                </button>
              )
            )}
            <button class="btn bad" onClick={() => respondPermission(c.toolUseId, 'deny')}>
              {ui.cards.deny}
              {active && <kbd>{ui.cards.esc}</kbd>}
            </button>
            <span class="hint">{edit ? ui.cards.editsHint : always?.hint}</span>
          </>
        )}
      </div>
    </div>
  );
}

export function QuestionCardView({ c, active }: { c: QuestionCard; active: boolean }) {
  const pending = c.state === 'pending';
  const target = replyTarget.value;
  const tag =
    c.state === 'answered'
      ? ui.cards.questionAnswered
      : c.state === 'declined'
        ? ui.cards.questionDeclined
        : c.state === 'cancelled'
          ? ui.cards.questionCancelled
          : ui.cards.question;
  const single = c.questions.length === 1 && !c.questions[0]!.multiSelect;
  return (
    <div class="ask">
      {c.questions.map((q, qi) => {
        const picks = c.picks[q.question] ?? [];
        const custom = c.custom[q.question];
        const awaiting =
          target?.kind === 'question' &&
          target.toolUseId === c.toolUseId &&
          target.question === q.question;
        return (
          <>
            <div class="h">
              {q.question}
              {qi === 0 ? (
                <Tag text={tag} {...(c.agentId ? { agentId: c.agentId } : {})} />
              ) : (
                q.header && <span class="tag">{q.header}</span>
              )}
            </div>
            {q.multiSelect && pending && (
              <div class="bd">
                <p class="dim">{ui.cards.multi}</p>
              </div>
            )}
            <div class="opts-list">
              {q.options.map((o, i) => (
                <button
                  class={picks.includes(o.label) ? 'opt sel' : 'opt'}
                  disabled={!pending}
                  onClick={() => chooseOption(c.toolUseId, q.question, o.label)}
                >
                  <span class="n">{i + 1}</span>
                  <span>
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </span>
                </button>
              ))}
              <button
                class={custom !== undefined || awaiting ? 'opt sel' : 'opt'}
                disabled={!pending}
                onClick={() => replyToQuestion(c.toolUseId, q.question)}
              >
                <span class="n">{q.options.length + 1}</span>
                <span>
                  {custom !== undefined ? custom : ui.cards.custom}
                  <small>{custom !== undefined ? ui.cards.custom : ui.cards.customHint}</small>
                </span>
              </button>
            </div>
          </>
        );
      })}
      {pending && (
        <div class="acts">
          {!single && (
            <button class="btn pri" onClick={() => submitQuestion(c.toolUseId)}>
              {ui.cards.submit}
            </button>
          )}
          <button class="btn bad" onClick={() => declineQuestion(c.toolUseId)}>
            {ui.cards.deny}
            {active && <kbd>{ui.cards.esc}</kbd>}
          </button>
          {target?.toolUseId === c.toolUseId && <span class="hint">{ui.reply.question}</span>}
        </div>
      )}
    </div>
  );
}

export function PlanCardView({ c, cwd }: { c: PlanCard; cwd: string }) {
  const view = useMemo(() => planView(c.plan), [c.plan]);
  const html = useMemo(() => renderMarkdown(view.body), [view.body]);
  const pending = c.state === 'pending';
  const refining =
    replyTarget.value?.kind === 'plan' && replyTarget.value.toolUseId === c.toolUseId;
  const tag =
    c.state === 'done' && c.choice
      ? (ui.cards.planDone[c.choice] ?? '')
      : c.state === 'cancelled'
        ? ui.cards.planCancelled
        : ui.cards.planTag(view.steps, view.files.length);
  return (
    <div class="ask plan">
      <div class="h">
        {view.title}
        <Tag text={tag} {...(c.agentId ? { agentId: c.agentId } : {})} />
      </div>
      <div class="bd plan-body">
        <div class="md" onClick={onCodeCopyClick} dangerouslySetInnerHTML={{ __html: html }} />
        {view.files.length > 0 && (
          <div class="files">
            {view.files.map((f) => (
              <span>
                <b>{relPath(f.path, cwd)}</b>
                {f.note && <> · {f.note}</>}
              </span>
            ))}
          </div>
        )}
      </div>
      {pending && (
        <div class="acts">
          <button class="btn pri" onClick={() => decidePlan(c.toolUseId, 'run')}>
            {ui.cards.run}
          </button>
          <button class="btn" onClick={() => decidePlan(c.toolUseId, 'run-edits')}>
            {ui.cards.runEdits}
          </button>
          <button class="btn ghost" onClick={() => decidePlan(c.toolUseId, 'refine')}>
            {ui.cards.refine}
          </button>
          <button class="btn bad" onClick={() => decidePlan(c.toolUseId, 'reject')}>
            {ui.cards.reject}
          </button>
          {refining && <span class="hint">{ui.reply.plan}</span>}
        </div>
      )}
      {c.state === 'sent' && (
        <div class="acts">
          <span class="hint" style={{ marginLeft: 0 }}>
            {ui.cards.sent}
          </span>
        </div>
      )}
    </div>
  );
}
