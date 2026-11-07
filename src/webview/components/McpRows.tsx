/**
 * Строки сервера и скилла для всплывашки «mcp» у поля ввода и вкладки «mcp» правой панели (roadmap 21, этап 3):
 * одна вёрстка (`.srv`, как в прототипе tools-mcp.html), контейнеры разные.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { McpServerInfo } from '../../agent/types';
import { addSys } from '../chatState';
import { canOpenSkill, isBadServer, sessionSkills, type McpUsage, type SessionSkill } from '../mcpFeed';
import { loginCommand, mcpCounts, sourceLabel, usageByServer } from '../mcpView';
import { capabilities, chat, features, provider, skillFiles } from '../store';
import { ui } from '../strings';
import { send } from '../vscode';

const dotClass = (s: McpServerInfo): string =>
  s.status === 'failed'
    ? 'fail'
    : s.status === 'needs-auth'
      ? 'auth'
      : s.status === 'disabled' || s.status === 'pending'
        ? 'off'
        : '';

/** Команда — в буфер; буфера нет (webview без доступа) — строкой в ленту, как ссылка RC (`copyLink` в Composer). */
function copyText(text: string): Promise<void> {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  const p = clip?.writeText ? clip.writeText(text) : Promise.reject(new Error('no clipboard'));
  return p.catch((e: unknown) => {
    chat.value = addSys(chat.value, [ui.sys.mcpCommand(text)]);
    throw e;
  });
}

/** Подсказка входа у сервера в `needs-auth`: текст и «скопировать команду» (кнопки авторизации в SDK нет). */
function LoginHint({ name, engine }: { name: string; engine: string | undefined }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(id);
  }, [done]);
  const cmd = loginCommand(engine, name);
  return (
    <div class="srv-hint">
      <span>{engine === 'codex' ? ui.mcp.loginCodex(name) : ui.mcp.loginClaude}</span>
      <button
        type="button"
        class="act"
        onClick={() =>
          void copyText(cmd)
            .then(() => setDone(true))
            .catch(() => undefined)
        }
      >
        {done ? ui.mcp.copied : ui.mcp.copyCommand}
      </button>
    </div>
  );
}

/**
 * Строка сервера: статус-точка, имя с меткой источника и пометкой (версия / «встроенный» / ошибка), справа «повторить»
 * или счётчики, последней колонкой — тумблер (`canSwitch`, roadmap 22; у встроенного пустое место, чтобы колонки ровно).
 * `onToggle` — строка раскрывается по клику (вкладка панели): ниже вызовы по тулам.
 */
export function McpServerRow({
  server,
  usage,
  engine,
  canReconnect,
  onReconnect,
  canSwitch,
  onSwitch,
  expanded,
  onToggle,
  pane = false,
}: {
  pane?: boolean;
  server: McpServerInfo;
  usage?: McpUsage | undefined;
  engine: string | undefined;
  canReconnect: boolean;
  onReconnect: (name: string) => void;
  /** Показывать тумблер вкл/выкл (`features.mcpToggle`); у `builtin` его нет в любом случае. */
  canSwitch?: boolean;
  onSwitch?: (name: string, enabled: boolean) => void;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const s = server;
  const notes: string[] = [];
  if (s.status === 'connected') {
    if (s.version) notes.push(ui.mcp.version(s.version));
    if (s.builtin) notes.push(ui.mcp.builtin);
  } else if (s.status !== 'failed') {
    notes.push(ui.mcp.status[s.status] ?? s.status);
  }
  const err = s.status === 'failed' ? (s.error ?? ui.mcp.status['failed']) : undefined;
  const calls = usage?.total ?? 0;
  const tools = s.status === 'connected' && s.tools !== undefined ? ui.mcp.tools(s.tools) : '';
  const disabled = s.status === 'disabled';
  const showCalls = s.status === 'connected' || disabled || calls > 0;
  const src = s.builtin ? undefined : sourceLabel(s.scope);
  const switchable = !!canSwitch && !s.builtin && !(engine === 'codex' && s.scope === 'plugin');
  const expandable = !!onToggle && calls > 0;
  if (pane) {
    const switchTip = engine === 'codex'
      ? ui.mcp.toggleCodexTip(s.name, disabled)
      : disabled ? ui.mcp.toggleOnTip(s.name) : ui.mcp.toggleOffTip(s.name);
    return (
      <section class="mcp-server" data-name={s.name} data-status={s.status}>
        <div class="mcp-server-top">
          <button type="button" class="mcp-server-open" aria-expanded={!!expanded}
            aria-label={ui.mcp.serverDetails(s.name)} onClick={onToggle}>
            <span class={`mcp-dot ${dotClass(s)}`} aria-hidden="true" />
            <span><b>{s.name}</b><small>
              {s.status === 'connected' ? (tools || ui.mcp.status.connected) : ui.mcp.status[s.status]}
              {s.status === 'connected' && ` · ${calls} ${ui.mcp.calls(calls)}`}
              {(s.builtin || src) && ` · ${s.builtin ? ui.mcp.builtin : src}`}
            </small></span>
            <span class="mcp-chevron" aria-hidden="true">›</span>
          </button>
          {switchable && <button type="button" class="mcp-switch" role="switch"
            aria-checked={!disabled} aria-label={switchTip} data-tip={switchTip}
            onClick={() => onSwitch?.(s.name, disabled)} />}
        </div>
        {expanded && <div class="mcp-details">
          {s.version && <p>{ui.mcp.version(s.version)}</p>}
          {err && <p class="err">{err}</p>}
          {s.status === 'failed' && canReconnect && <button type="button" class="mcp-action"
            onClick={() => onReconnect(s.name)}>{ui.mcp.reconnect}</button>}
          {s.status === 'needs-auth' && <LoginHint name={s.name} engine={engine} />}
          {usage?.total ? [...usage.tools].map(([tool, n]) => <p key={tool}><code>{tool}</code> ×{n}</p>)
            : <p>{ui.mcp.noCalls}</p>}
        </div>}
      </section>
    );
  }
  const nm = (
    <>
      {s.name}
      {src && <span class="src">{src}</span>}
      {notes.length > 0 && <small>{notes.join(' · ')}</small>}
      {err && (
        <small class="err" data-tip={err}>
          {err}
        </small>
      )}
    </>
  );
  return (
    <>
      <div
        class={`srv${canSwitch ? ' tgl' : ''}${disabled ? ' off' : ''}${s.status === 'needs-auth' ? ' dim' : ''}`}
        data-status={s.status}
        data-name={s.name}
      >
        <span class={`st ${dotClass(s)}`} aria-hidden="true" />
        {expandable ? (
          <button
            type="button"
            class="nm nmb"
            aria-expanded={!!expanded}
            aria-label={ui.mcp.expandServer(s.name)}
            onClick={onToggle}
          >
            {nm}
          </button>
        ) : (
          <span class="nm">{nm}</span>
        )}
        {s.status === 'failed' && canReconnect ? (
          <button
            type="button"
            class="act"
            data-tip={ui.mcp.reconnectTip(s.name)}
            onClick={() => onReconnect(s.name)}
          >
            {ui.mcp.reconnect}
          </button>
        ) : (
          <span class="n">
            {tools}
            {tools && showCalls ? ' · ' : ''}
            {calls > 0 ? (
              <>
                <b>{calls}</b> {ui.mcp.calls(calls)}
              </>
            ) : (
              showCalls && '—'
            )}
          </span>
        )}
        {switchable ? (
          <button
            type="button"
            role="switch"
            class={`tg${disabled ? '' : ' on'}`}
            aria-checked={!disabled}
            aria-label={ui.mcp.chipTip(s.name)}
            data-tip={engine === 'codex'
              ? ui.mcp.toggleCodexTip(s.name, disabled)
              : disabled ? ui.mcp.toggleOnTip(s.name) : ui.mcp.toggleOffTip(s.name)}
            onClick={() => onSwitch?.(s.name, disabled)}
          />
        ) : (
          canSwitch && <span />
        )}
      </div>
      {s.status === 'needs-auth' && <LoginHint name={s.name} engine={engine} />}
      {expandable && expanded && usage && (
        <div class="exp">
          {[...usage.tools].map(([tool, n], i) => (
            <span key={tool}>
              {i > 0 && ' · '}
              <b>{tool}</b> ×{n}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** Строка скилла сессии: имя, как вызван, «открыть SKILL.md» (только если хост нашёл файл и скилл не плагинный). */
export function McpSkillRow({
  skill,
  canOpen,
  onOpen,
}: {
  skill: SessionSkill;
  canOpen: boolean;
  onOpen: (name: string) => void;
}) {
  return (
    <div class="srv sk" data-skill={skill.name}>
      <span class="st" aria-hidden="true" />
      <span class="nm">
        {skill.name}
        <small>{ui.mcp.skillBy(skill.how)}</small>
      </span>
      {canOpen ? (
        <button type="button" class="act" onClick={() => onOpen(skill.name)}>
          {ui.mcp.openSkill}
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** «все скиллы…»: раскрывает список имён доступных скиллов (без вызовов — только перечень). */
export function McpAllSkills({ names, label }: { names: readonly string[]; label: string }) {
  const [open, setOpen] = useState(false);
  if (names.length === 0) return null;
  return (
    <>
      <button type="button" class="more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? ui.mcp.hideSkills : label}
      </button>
      {open && (
        <div class="allsk">
          {names.map((n) => (
            <span key={n} class="sk1">
              {n}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

const reconnect = (name: string) => send({ type: 'mcp.reconnect', name });
const switchServer = (name: string, enabled: boolean) => send({ type: 'mcp.toggle', name, enabled });
const openSkill = (name: string) => send({ type: 'skill.open', name });

/**
 * Содержимое всплывашки и вкладки: серверы (статус, версия, тулы, вызовы, «повторить» / подсказка входа) и скиллы
 * сессии. Вёрстка одна (`.srv`); `pane` добавляет раскрытие сервера по тулам и свои подписи. Состояние — `chat.value.mcp`
 * (нет — пусто), вызовы и скиллы считаются по `rows` только пока блок виден (`idle` — не считать).
 */
export function McpSections({ variant, idle }: { variant: 'pop' | 'pane'; idle?: boolean }) {
  const s = chat.value;
  const servers = s.mcp?.servers;
  const rows = s.rows;
  const f = features.value;
  const engine = s.engine ?? provider.value;
  const nativeSkills = engine === 'codex' ? capabilities.value.commands.filter((c) => c.skillPath) : [];
  const availableCount = engine === 'codex' ? nativeSkills.length : s.skills.length;
  const usage = useMemo(
    () => (idle || !servers ? new Map<string, McpUsage>() : usageByServer(servers, rows)),
    [idle, servers, rows],
  );
  const used = useMemo(
    () => (idle || !f.skills ? [] : sessionSkills(rows, s.skills)),
    [idle, f.skills, rows, s.skills],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  if (!servers) return null;
  const c = mcpCounts(servers);
  const pane = variant === 'pane';
  const toggle = (name: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };
  const skillsContent = (f.skills && (
        <>
          {!pane && <hr />}
          <h5 class={pane ? 'sk-head' : undefined}>
            {pane ? ui.mcp.skillsPaneHead : ui.mcp.skillsHead}
            <em>{pane ? ui.mcp.usedOf(used.length, availableCount) : ui.mcp.available(availableCount)}</em>
          </h5>
          {used.length === 0 && <div class="srv dim">{ui.mcp.noSkillsUsed}</div>}
          {used.map((k) => (
            <McpSkillRow
              key={k.name}
              skill={k}
              canOpen={canOpenSkill(k.name, skillFiles.value)}
              onOpen={openSkill}
            />
          ))}
          {nativeSkills.map((skill) => <div class="srv" key={skill.skillPath}>
            <span title={skill.skillPath}>{skill.name}</span>
            <button type="button" class="act" title={skill.skillPath} onClick={() => send({ type: 'skill.open', name: skill.name, path: skill.skillPath })}>SKILL.md</button>
          </div>)}
          <McpAllSkills names={s.skills} label={pane ? ui.mcp.allSkillsPane : ui.mcp.allSkills} />
        </>
      ));
  if (pane) {
    const visible = servers.filter((sv) => sv.name.toLowerCase().includes(query.trim().toLowerCase())
      && (!attentionOnly || isBadServer(sv)));
    const groups = [
      { label: ui.mcp.attention, items: visible.filter(isBadServer) },
      { label: ui.mcp.connectedGroup, items: visible.filter((sv) => sv.status === 'connected') },
      { label: ui.mcp.pendingGroup, items: visible.filter((sv) => sv.status === 'pending') },
      { label: ui.mcp.disabledGroup, items: visible.filter((sv) => sv.status === 'disabled') },
    ];
    const toolsKnown = servers.filter((sv) => sv.status === 'connected').every((sv) => sv.tools !== undefined);
    const toolCount = servers.reduce((n, sv) => n + (sv.status === 'connected' ? sv.tools ?? 0 : 0), 0);
    return <div class="mcp-workspace">
      <header class="mcp-head">
        <span class="eyebrow">{s.project}{s.project && ' / '}{engine}</span>
        <div class="mcp-title"><h2>{ui.mcp.menuTitle}</h2>
          <button type="button" class="mcp-action" aria-label={ui.mcp.refresh} data-tip={ui.mcp.refresh}
            onClick={() => send({ type: 'mcp.refresh' })}>↻</button>
        </div>
        <p><strong>{ui.mcp.connectedSummary(c.n, servers.length)}</strong>{toolsKnown && ` · ${ui.mcp.tools(toolCount)}`}</p>
        {f.mcpReloadAll && <button type="button" class="mcp-action" data-tip={ui.mcp.reloadAllTip}
          onClick={() => send({ type: 'mcp.reloadAll' })}>{ui.mcp.reloadAll}</button>}
      </header>
      <label class="mcp-search"><input type="search" value={query} placeholder={ui.mcp.searchServers}
        aria-label={ui.mcp.searchServers} onInput={(e) => setQuery(e.currentTarget.value)} /></label>
      <div class="mcp-filters">
        <button type="button" aria-pressed={!attentionOnly} onClick={() => setAttentionOnly(false)}>{ui.mcp.allServers} {servers.length}</button>
        <button type="button" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(true)}>{ui.mcp.attention} {c.bad}</button>
      </div>
      <div class="mcp-results">
        {groups.filter((g) => g.items.length).map((g) => <section key={g.label}>
          <div class="mcp-group-title">{g.label} · {g.items.length}</div>
          {g.items.map((sv) => <McpServerRow key={sv.name} pane server={sv} usage={usage.get(sv.name)} engine={engine}
            canReconnect={f.mcpReconnect} onReconnect={reconnect} canSwitch={f.mcpToggle} onSwitch={switchServer}
            expanded={open.has(sv.name)} onToggle={() => toggle(sv.name)} />)}
        </section>)}
        {!visible.length && <p class="mcp-empty" role="status">{!servers.length ? ui.mcp.noServers : query.trim() ? ui.mcp.noMatches : ui.mcp.allHealthy}</p>}
      </div>
      {(f.skills || f.mcpToggle) && <footer class="mcp-footer">
        {f.skills && <details><summary>{ui.mcp.skillsPaneHead} · {used.length}</summary>{skillsContent}</details>}
        {f.mcpToggle && <p>{ui.mcp.projectScope}</p>}
      </footer>}
    </div>;
  }
  return (
    <>
      <h5>
        {ui.mcp.menuTitle}
        <em>
          {pane ? `${c.n}/${c.m}` : `${c.n} / ${c.m}`}
          {f.mcpReloadAll && (
            <button
              type="button"
              class="act"
              data-tip={ui.mcp.reloadAllTip}
              onClick={() => send({ type: 'mcp.reloadAll' })}
            >
              {ui.mcp.reloadAll}
            </button>
          )}
          <button
            type="button"
            class="rf"
            data-tip={ui.mcp.refresh}
            aria-label={ui.mcp.refresh}
            onClick={() => send({ type: 'mcp.refresh' })}
          >
            ↻
          </button>
        </em>
      </h5>
      {servers.length === 0 && <div class="srv dim">{ui.mcp.noServers}</div>}
      {servers.map((sv) => (
        <McpServerRow
          key={sv.name}
          server={sv}
          usage={usage.get(sv.name)}
          engine={engine}
          canReconnect={f.mcpReconnect}
          onReconnect={reconnect}
          canSwitch={f.mcpToggle}
          onSwitch={switchServer}
          {...(pane ? { expanded: open.has(sv.name), onToggle: () => toggle(sv.name) } : {})}
        />
      ))}
      {skillsContent}
    </>
  );
}
