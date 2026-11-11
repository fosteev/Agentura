import { render, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AgentProvider } from '../../agent/types';
import { NEW_CHAT_PROMPT_LIMIT } from '../../shared/task';
import type { TaskPickerError, TaskPickerResult } from '../../shared/taskPicker';
import { ENGINE_MARK, ENGINE_MARK_CLASS } from '../engineLimitsView';
import { ui, uiLang } from '../strings';
import { onHostMessage, send } from '../vscode';

let nextRequest = 0;
const engines: AgentProvider[] = ['claude', 'codex', 'antigravity', 'cursor'];

// Keep overlays outside the sidebar scroll/zoom root. Importing preact/compat here
// would globally turn native change events into input events, committing Settings drafts.
function Floating({ children }: { children: ComponentChildren }) {
  const container = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = document.createElement('div');
    document.body.append(element);
    container.current = element;
    return () => {
      render(null, element);
      element.remove();
    };
  }, []);
  useLayoutEffect(() => {
    if (container.current) render(children, container.current);
  }, [children]);
  return null;
}

export function SidebarTaskPicker({ detailed = false }: { detailed?: boolean }) {
  const t = ui.sidebar.taskPicker;
  const [menu, setMenu] = useState(false);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<TaskPickerResult>();
  const [pending, setPending] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<TaskPickerError>();
  const [creating, setCreating] = useState(false);
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [prompt, setPrompt] = useState('');
  const [anchor, setAnchor] = useState({ left: 8, top: 8 });
  const request = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  function close() {
    request.current = 0;
    send({ type: 'task.picker.cancel' });
    setOpened(false);
    trigger.current?.focus();
  }

  useEffect(
    () =>
      onHostMessage((m) => {
        if (
          (m.type !== 'task.picker.result' && m.type !== 'task.picker.done') ||
          m.requestId !== request.current
        )
          return;
        if (m.type === 'task.picker.result') {
          setPending(false);
          setResult(m.result);
          setCreating(m.result.kind === 'found' && !m.result.existing);
        } else {
          setActing(false);
          if (m.error) {
            setError(m.error);
            if (m.error === 'stale') setResult(undefined);
          } else close();
        }
      }),
    [],
  );

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button')?.focus();
    const away = (e: Event) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);

  useEffect(() => {
    if (opened) input.current?.focus();
  }, [opened]);
  useEffect(
    () => () => {
      if (request.current) send({ type: 'task.picker.cancel' });
    },
    [],
  );

  useEffect(() => {
    if (creating) panel.current?.querySelector<HTMLTextAreaElement>('#sp-prompt')?.focus();
  }, [creating]);

  function open() {
    setMenu(false);
    setOpened(true);
    setQuery('');
    setResult(undefined);
    setError(undefined);
    setPending(false);
    setActing(false);
    setCreating(false);
    setPrompt('');
  }
  function find(instanceId?: string) {
    if (!query.trim() || acting) return;
    const requestId = ++nextRequest;
    request.current = requestId;
    setPending(true);
    setResult(undefined);
    setError(undefined);
    send({
      type: 'task.picker.find',
      requestId,
      query: query.trim(),
      ...(instanceId ? { instanceId } : {}),
    });
  }
  function changeQuery(value: string) {
    setQuery(value);
    setResult(undefined);
    setError(undefined);
    setPending(false);
    request.current = 0;
    send({ type: 'task.picker.cancel' });
  }
  function act(sessionId?: string, sessionProvider?: AgentProvider) {
    if (acting || result?.kind !== 'found') return;
    setActing(true);
    setError(undefined);
    send({
      type: 'task.picker.act',
      requestId: request.current,
      mode: sessionId || !creating ? 'open' : 'create',
      ...(sessionId
        ? { sessionId, provider: sessionProvider }
        : creating
          ? { provider, prompt: prompt.trim() }
          : {}),
    });
  }
  function keys(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!acting) close();
    }
    if (e.key === 'Tab') {
      const items = [
        ...panel.current!.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
        ),
      ];
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }
  const found = result?.kind === 'found' ? result : undefined;
  const problem = error ?? (result?.kind === 'error' ? result.code : undefined);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        class={detailed ? 'new' : 'add'}
        aria-label={t.add}
        aria-haspopup="menu"
        aria-expanded={menu}
        data-tip={t.add}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({
            left: Math.max(8, Math.min(r.right - 240, window.innerWidth - 248)),
            top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 120)),
          });
          setMenu(!menu);
        }}
      >
        <span class="plus">＋</span>
        {detailed && (
          <>
            {t.add}
            <span aria-hidden="true" style={{ marginLeft: 'auto' }}>
              ▾
            </span>
          </>
        )}
      </button>
      {menu && (
        <Floating>
          <div
            class="sp-menu"
            role="menu"
            ref={menuRef}
            style={{ left: anchor.left, top: anchor.top }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                send({ type: 'session.new' });
              }}
            >
              {t.newChat}
              <small>{t.plainHint}</small>
            </button>
            <button type="button" role="menuitem" onClick={open}>
              {t.open}
              <small>{t.linkHint}</small>
            </button>
          </div>
        </Floating>
      )}
      {opened && (
        <Floating>
          <div
            class="sp-overlay"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget && !acting) close();
            }}
          >
            <div
              class="ncp sp-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="sp-title"
              ref={panel}
              onKeyDown={keys}
            >
              <div class="ncp-head">
                <h6 id="sp-title">{t.open}</h6>
                <button
                  type="button"
                  class="x"
                  aria-label={ui.task.ncp.close}
                  disabled={acting}
                  onClick={close}
                >
                  ×
                </button>
              </div>
              <div class="ncp-body">
                <label class="lb" for="sp-query">
                  {t.input}
                </label>
                <div class="sp-link">
                  <input
                    id="sp-query"
                    ref={input}
                    value={query}
                    maxLength={2000}
                    placeholder={t.placeholder}
                    disabled={acting}
                    onInput={(e) => changeQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.isComposing) {
                        e.preventDefault();
                        find();
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!query.trim() || pending || acting}
                    onClick={() => find()}
                  >
                    {pending ? t.finding : t.find}
                  </button>
                </div>
                {pending && (
                  <p class="sp-note" role="status">
                    {t.loading}
                  </p>
                )}
                {problem && (
                  <div class="sp-notice" role="alert">
                    {t.errors[problem]}
                    {problem === 'no-source' && (
                      <button type="button" onClick={() => send({ type: 'task.connect' })}>
                        {t.connect}
                      </button>
                    )}
                  </div>
                )}
                {result?.kind === 'instances' && (
                  <div class="sp-instances">
                    <p>{t.chooseInstance}</p>
                    {result.instances.map((i) => (
                      <button type="button" key={i.id} onClick={() => find(i.id)}>
                        {i.name}
                        <small>{i.baseUrl}</small>
                      </button>
                    ))}
                  </div>
                )}
                {found && (
                  <>
                    <p class="sp-note">
                      {found.instance.name} · {found.instance.baseUrl}
                    </p>
                    <div class="sp-card">
                      <div>
                        <span class="k">{found.key}</span>
                        <span class="sp-status">{found.status}</span>
                      </div>
                      <h2>{found.title}</h2>
                    </div>
                    {found.existing && (
                      <div class="sp-existing">
                        <p class="sp-found">{t.existing(found.chats.length)}</p>
                        {found.chats.length > 0 && (
                          <div class="sp-chats">
                            {found.chats.map((c) => (
                              <button
                                type="button"
                                key={`${c.provider}:${c.id}`}
                                disabled={acting}
                                onClick={() => act(c.id, c.provider)}
                              >
                                <i class={`mk ${ENGINE_MARK_CLASS[c.provider]}`}>
                                  {ENGINE_MARK[c.provider]}
                                </i>
                                <span class="sp-chat-copy">
                                  {c.title}
                                  <small>
                                    {ui.sidebar.providerNames[c.provider]} ·{' '}
                                    {new Date(c.updatedAt).toLocaleString(uiLang)}
                                    {c.archived ? ` · ${t.archived}` : ''}
                                  </small>
                                </span>
                                <span aria-hidden="true">↗</span>
                              </button>
                            ))}
                          </div>
                        )}
                        <p class="sp-note">{t.existingHint}</p>
                      </div>
                    )}
                    {creating && (
                      <div class="sp-create">
                        <div class="lb">{t.agent}</div>
                        <div class="seg engines" role="radiogroup" aria-label={t.agent}>
                          {engines.map((p) => (
                            <button
                              type="button"
                              key={p}
                              role="radio"
                              aria-checked={p === provider}
                              disabled={acting}
                              class={p === provider ? 'on' : ''}
                              onClick={() => setProvider(p)}
                            >
                              <i class={`mk ${ENGINE_MARK_CLASS[p]}`}>{ENGINE_MARK[p]}</i>
                              {ui.sidebar.providerNames[p]}
                            </button>
                          ))}
                        </div>
                        <div class="ncp-prompt">
                          <label class="lb" for="sp-prompt">
                            {ui.task.ncp.promptLabel}
                            <span class="optional">{ui.task.ncp.optional}</span>
                          </label>
                          <textarea
                            id="sp-prompt"
                            class="inp"
                            value={prompt}
                            disabled={acting}
                            maxLength={NEW_CHAT_PROMPT_LIMIT}
                            placeholder={ui.task.ncp.promptPh}
                            onInput={(e) => setPrompt(e.currentTarget.value)}
                          />
                        </div>
                        <p class="sp-note">{t.contextHint}</p>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div class="ft">
                {found?.existing && !creating && (
                  <button
                    type="button"
                    class="sec sp-new"
                    disabled={acting}
                    onClick={() => setCreating(true)}
                  >
                    ＋ {t.newChat}
                  </button>
                )}
                <button
                  type="button"
                  class="go"
                  disabled={!found || acting || pending}
                  onClick={() => act()}
                >
                  {acting ? t.opening : creating ? ui.task.ncp.create : t.openTask}
                </button>
              </div>
            </div>
          </div>
        </Floating>
      )}
    </>
  );
}
