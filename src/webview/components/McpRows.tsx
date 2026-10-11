/**
 * Строки сервера и скилла для всплывашки «mcp» у поля ввода и вкладки «mcp» правой панели (roadmap 21, этап 3):
 * одна вёрстка (`.srv`, как в прототипе tools-mcp.html), контейнеры разные.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { McpServerInfo } from '../../agent/types';
import { addSys } from '../chatState';
import { canOpenSkill, sessionSkills, type McpUsage, type SessionSkill } from '../mcpFeed';
import { loginCommand, mcpCounts, usageByServer } from '../mcpView';
import { chat, features, provider, skillFiles } from '../store';
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
 * Строка сервера: статус-точка, имя с пометкой (версия / «встроенный» / ошибка), справа «повторить» или счётчики.
 * `onToggle` — строка раскрывается по клику (вкладка панели): ниже вызовы по тулам.
 */
export function McpServerRow({
  server,
  usage,
  engine,
  canReconnect,
  onReconnect,
  expanded,
  onToggle,
}: {
  server: McpServerInfo;
  usage?: McpUsage | undefined;
  engine: string | undefined;
  canReconnect: boolean;
  onReconnect: (name: string) => void;
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
  const showCalls = s.status === 'connected' || calls > 0;
  const expandable = !!onToggle && calls > 0;
  const nm = (
    <>
      {s.name}
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
      <div class={`srv${s.status === 'needs-auth' ? ' dim' : ''}`} data-status={s.status} data-name={s.name}>
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
                <b>{calls}</b> {ui.mcp.calls}
              </>
            ) : (
              showCalls && '—'
            )}
          </span>
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
  const usage = useMemo(
    () => (idle || !servers ? new Map<string, McpUsage>() : usageByServer(servers, rows)),
    [idle, servers, rows],
  );
  const used = useMemo(
    () => (idle || !f.skills ? [] : sessionSkills(rows, s.skills)),
    [idle, f.skills, rows, s.skills],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (!servers) return null;
  const c = mcpCounts(servers);
  const pane = variant === 'pane';
  const toggle = (name: string) => {
    const next = new Set(open);
    if (!next.delete(name)) next.add(name);
    setOpen(next);
  };
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
          {...(pane ? { expanded: open.has(sv.name), onToggle: () => toggle(sv.name) } : {})}
        />
      ))}
      {f.skills && (
        <>
          {!pane && <hr />}
          <h5 class={pane ? 'sk-head' : undefined}>
            {pane ? ui.mcp.skillsPaneHead : ui.mcp.skillsHead}
            <em>{pane ? ui.mcp.usedOf(used.length, s.skills.length) : ui.mcp.available(s.skills.length)}</em>
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
          <McpAllSkills names={s.skills} label={pane ? ui.mcp.allSkillsPane : ui.mcp.allSkills} />
        </>
      )}
    </>
  );
}
