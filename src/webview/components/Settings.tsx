import { uiZoom } from '../appearance';
import type { ComponentChildren } from 'preact';
import type { AgentProvider } from '../../agent/types';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  EFFORT_LEVELS,
  LANGUAGE_MODES,
  MAX_POLL_MINUTES,
  MIN_POLL_MINUTES,
  SESSION_LIST_MODES,
  PROVIDERS,
  SIDEBAR_LIMITS_MODES,
  JIRA_SOURCES,
  TASK_CARD_MODES,
  TASK_TAB_MODES,
  TASK_REFRESH_MODES,
  TASK_SIDEBAR_MODES,
  SIDEBAR_TOP_MODES,
  COMPOSER_LAYOUTS,
  FEED_STYLES,
  AGENTS_VIEWS,
  GIT_LAYOUTS,
  HIGHLIGHT_THEMES,
  MAX_DIFF_FONT_SIZE,
  MCP_FEED_STATUS_MODES,
  DEFAULT_FEED_FONT_SIZE,
  MAX_FEED_FONT_SIZE,
  MIN_FEED_FONT_SIZE,
  thresholdsError,
  validateSetting,
  type SettingKey,
  type SettingsValues,
} from '../../settings';
import {
  addFont,
  checkEngine,
  commit,
  agyCheck,
  codexCheck,
  cursorCheck,
  codexModels,
  antigravityModels,
  engineCheck,
  errors,
  extensionVersion,
  integrations,
  integrationsAction,
  overridden,
  removeFont,
  requestedSection,
  reveal,
  setError,
  settingsValues,
} from '../settingsStore';
import { ui, uiLang } from '../strings';
import {
  AgentsPreview,
  ChoiceCards,
  ComposerPreview,
  FeedPreview,
  GitPreview,
  SidebarPreview,
  TaskCardPreview,
  TaskTabPreview,
} from './SettingsPreview';
import { fontStack } from '../appearance';
import { JIRA_TOOLS, type AgentToolsSetting } from '../../shared/jiraTools';
import { codeFonts, installedFonts, uiFonts, userFonts } from '../fonts';
import {
  SETTINGS_SECTIONS,
  readSettingsSection,
  saveSettingsSection,
  send,
  type SettingsSection as Section,
} from '../vscode';

const T = ui.settings;
const S = T.sessionUi;
const sessionProviders: readonly [AgentProvider, string, string][] = [
  ['claude', 'Claude', 'Anthropic'], ['codex', 'Codex', 'OpenAI'],
  ['cursor', 'Cursor', 'Cursor'], ['antigravity', 'Antigravity', 'Google'],
];
const sessionKeys: Record<AgentProvider, SettingKey[]> = {
  claude: ['defaultModel', 'defaultEffort', 'defaultPermissionMode', 'remoteControl', 'remoteControlNamePrefix'],
  codex: ['codex.defaultModel', 'codex.defaultEffort', 'codex.defaultApproval', 'codex.defaultSandbox'],
  cursor: ['cursor.defaultModel', 'defaultPermissionMode'],
  antigravity: ['antigravity.defaultModel', 'antigravity.defaultEffort', 'defaultPermissionMode'],
};
/** Ширина вкладки, с которой разделы — колонкой слева (уже — полосой вкладок над страницей). */
const NAV_PX = 600;
/** Разделы — отдельные страницы (не якоря одной ленты); открытый раздел помнит состояние webview. */
const SECTIONS = SETTINGS_SECTIONS;

/** Черновик поля: пока человек печатает, показываем его; пришло новое значение из хоста — берём его. */
function useDraft<V>(value: V): [V, (v: V) => void] {
  const [draft, setDraft] = useState(value);
  // Синхронизируем до ввода: отложенный effect может стереть свежий черновик при смене вкладки.
  useLayoutEffect(() => setDraft(value), [JSON.stringify(value)]);
  return [draft, setDraft];
}

function Row({
  name,
  isNew,
  desc,
  k,
  machine,
  keyNote,
  on,
  children,
  below,
}: {
  name: string;
  isNew?: boolean;
  desc: string;
  k: SettingKey;
  machine?: boolean;
  keyNote?: string;
  on?: boolean;
  children: ComponentChildren;
  below?: ComponentChildren;
}) {
  const err = errors.value[k];
  return (
    <div class={on ? 'set on' : 'set'} data-key={`agentura.${k}`}>
      <span class="nm">
        {name}
        {isNew ? <span class="new">{T.isNew}</span> : null}
      </span>
      <span class="ds">{desc}</span>
      <span class="key">
        agentura.{k}
        {keyNote ? ` · ${keyNote}` : ''}
        {machine ? ` · ${T.machineOnly}` : ''}
      </span>
      <span class="ctl">{children}</span>
      {overridden.value.includes(k) ? <div class="note">{T.overridden}</div> : null}
      {err ? (
        <div class="err" role="alert">
          {err}
        </div>
      ) : null}
      {below}
    </div>
  );
}

function Toggle({ k, value, danger }: { k: SettingKey; value: boolean; danger?: boolean }) {
  // ожидаемое значение до ответа хоста: двойной клик даёт «вкл → выкл», а не две записи «вкл»
  const [want, setWant] = useState<boolean | undefined>(undefined);
  const err = errors.value[k];
  useEffect(() => setWant(undefined), [value, err]);
  const shown = want ?? value;
  return (
    <button
      type="button"
      class={`tg${shown ? ' on' : ''}${danger ? ' danger' : ''}`}
      role="switch"
      aria-checked={shown}
      aria-label={k}
      onClick={() => {
        setWant(!shown);
        commit(k, !shown);
      }}
    />
  );
}

function Select({
  k,
  value,
  options,
  disabled,
}: {
  k: SettingKey;
  value: string;
  options: readonly (readonly [string, string, boolean?])[];
  disabled?: boolean;
}) {
  // отказ записи: перерисовать, чтобы <select> вернулся к значению из настроек
  void errors.value[k];
  return (
    <span class="dd">
      <select
        aria-label={k}
        value={value}
        disabled={disabled}
        onChange={(e) => commit(k, (e.currentTarget as HTMLSelectElement).value)}
      >
        {options.map(([v, label, off]) => (
          <option key={v} value={v} disabled={off}>
            {label}
          </option>
        ))}
      </select>
    </span>
  );
}

function TextField({
  k,
  value,
  placeholder,
  wide,
}: {
  k: SettingKey;
  value: string;
  placeholder?: string;
  wide?: boolean;
}) {
  const [draft, setDraft] = useDraft(value);
  const send = (text: string) => {
    if (text.trim() !== value) commit(k, text);
    else setError(k, undefined);
  };
  return (
    <input
      class={wide ? 'num wide' : 'num'}
      type="text"
      aria-label={k}
      value={draft}
      placeholder={placeholder}
      spellcheck={false}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onChange={(e) => send((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') send((e.currentTarget as HTMLInputElement).value);
      }}
    />
  );
}

/** Строка страницы, которой нет среди настроек (Jiraffe, свои подключения): та же вёрстка `.set`, но без `data-key`. */
function InfoRow({
  name,
  desc,
  keyText,
  children,
  below,
}: {
  name: string;
  desc: string;
  keyText: string;
  children?: ComponentChildren;
  below?: ComponentChildren;
}) {
  return (
    <div class="set">
      <span class="nm">{name}</span>
      <span class="ds">{desc}</span>
      <span class="key">{keyText}</span>
      <span class="ctl">{children}</span>
      {below}
    </div>
  );
}

/**
 * Инструменты Jira для агента (этап 8): три флажка пишут `agentura.jira.agentTools` целиком. Источник не пишет в Jira
 * (нет источника, Jiraffe без API v2) — флажки неактивны и причина рядом (решение 14).
 */
function AgentToolsBoxes({ value, writes }: { value: AgentToolsSetting; writes: boolean }) {
  const A = T.integrations.agentTools;
  void errors.value['jira.agentTools']; // отказ записи — перерисовать флажки по значению из настроек
  return (
    <div class="cbs" aria-disabled={writes ? undefined : 'true'}>
      {JIRA_TOOLS.map((t) => (
        <label key={t} class={writes ? undefined : 'off'}>
          <input
            type="checkbox"
            disabled={!writes}
            checked={value[t]}
            aria-label={A[t]}
            onChange={(e) => commit('jira.agentTools', { ...value, [t]: (e.currentTarget as HTMLInputElement).checked })}
          />
          {A[t]}
          {t !== 'comment' && <em> {A.ask}</em>}
        </label>
      ))}
      {!writes && <em class="soon">{A.noWrite}</em>}
    </div>
  );
}

/** Движки, чьи лимиты не показывать в боковой панели: флажок «показывать» на движок, пишут список скрытых целиком. */
function HiddenEnginesBoxes({ value }: { value: readonly AgentProvider[] }) {
  void errors.value['sidebar.limitsHidden']; // отказ записи — перерисовать флажки по значению из настроек
  return (
    <div class="cbs">
      {PROVIDERS.map((p) => (
        <label key={p}>
          <input
            type="checkbox"
            checked={!value.includes(p)}
            aria-label={T.limitsHidden.engines[p]}
            onChange={(e) =>
              commit(
                'sidebar.limitsHidden',
                (e.currentTarget as HTMLInputElement).checked ? value.filter((x) => x !== p) : [...value, p],
              )
            }
          />
          {T.limitsHidden.engines[p]}
        </label>
      ))}
    </div>
  );
}

/** Страница «Интеграции» (roadmap 19, этап 6, решение 14): источник Jira, Jiraffe, свои подключения, обновление и инструменты агента. */
function IntegrationsRows({ v }: { v: SettingsValues }) {
  const I = T.integrations;
  const st = integrations.value;
  const sources: [string, string][] = JIRA_SOURCES.map((s) => [s, I.source.options[s] ?? s]);
  const refresh: [string, string][] = TASK_REFRESH_MODES.map((m) => [m, I.refresh.options[m] ?? m]);
  const jf = st?.jiraffe;
  const ver = jf?.version ?? '';
  const jiraffeLine = () => {
    if (!jf) return null;
    if (jf.state === 'absent')
      return (
        <div class="ok bad" role="status">
          {I.jiraffe.absent}
        </div>
      );
    if (jf.state === 'no-api')
      return (
        <div class="ok bad" role="status">
          {I.jiraffe.noApi(ver)}
        </div>
      );
    if (jf.state === 'inactive')
      return (
        <div class="ok" role="status">
          <span class="dim">{I.jiraffe.inactive(ver)}</span>
        </div>
      );
    return (
      <div class="ok" role="status">
        {I.jiraffe.ready(ver)}
        <span class="dim">
          {' · '}
          {jf.instances.length
            ? `${I.jiraffe.instances(jf.instances.length)}: ${jf.instances.map((i) => i.name).join(', ')}`
            : I.jiraffe.noInstances}
        </span>
      </div>
    );
  };
  const activeLine = st
    ? st.active === 'jiraffe'
      ? I.source.activeJiraffe
      : st.active === 'own'
        ? I.source.activeOwn
        : I.source.activeNone
    : null;
  return (
    <>
      <Row
        name={I.source.name}
        isNew
        desc={I.source.desc}
        k="jira.source"
        below={
          activeLine ? (
            <div class={st?.active ? 'ok' : 'ok bad'} role="status">
              {activeLine}
            </div>
          ) : null
        }
      >
        <Select k="jira.source" value={v['jira.source']} options={sources} />
      </Row>
      <InfoRow name={I.jiraffe.name} desc={I.jiraffe.desc} keyText="fosteev.jiraffe" below={jiraffeLine()}>
        {jf?.state === 'absent' && (
          <button type="button" class="btn" onClick={() => integrationsAction.installJiraffe()}>
            {I.jiraffe.install}
          </button>
        )}
      </InfoRow>
      <InfoRow
        name={I.own.name}
        desc={I.own.desc}
        keyText="agentura.jira.connect"
        below={
          <div class="cn" role="list" aria-label={I.own.aria}>
            {st && st.own.length === 0 && <div class="empty">{I.own.empty}</div>}
            {st?.own.map((i) => (
              <div class="r" role="listitem" key={i.id} data-instance={i.id}>
                <span class="n">{i.name}</span>
                <span class="u">{i.baseUrl}</span>
                <span class="k">{I.own.kind[i.kind] ?? i.kind}</span>
                <button type="button" class="btn" onClick={() => integrationsAction.test(i.id)}>
                  {I.own.test}
                </button>
                <button type="button" class="btn" onClick={() => integrationsAction.disconnect(i.id)}>
                  {I.own.remove}
                </button>
              </div>
            ))}
          </div>
        }
      >
        <button type="button" class="btn" onClick={() => integrationsAction.connect()}>
          {I.own.connect}
        </button>
      </InfoRow>
      <Row name={I.refresh.name} isNew desc={I.refresh.desc} k="tasks.refresh">
        <Select k="tasks.refresh" value={v['tasks.refresh']} options={refresh} />
      </Row>
      <Row name={I.humanChanges.name} isNew desc={I.humanChanges.desc} k="tasks.humanChanges">
        <Toggle k="tasks.humanChanges" value={v['tasks.humanChanges']} />
      </Row>
      <Row name={I.matchMessage.name} isNew desc={I.matchMessage.desc} k="tasks.code.matchMessage">
        <Toggle k="tasks.code.matchMessage" value={v['tasks.code.matchMessage']} />
      </Row>
      <Row name={I.matchBranch.name} isNew desc={I.matchBranch.desc} k="tasks.code.matchBranch">
        <Toggle k="tasks.code.matchBranch" value={v['tasks.code.matchBranch']} />
      </Row>
      <Row name={I.agentTools.name} isNew desc={I.agentTools.desc} k="jira.agentTools">
        <AgentToolsBoxes value={v['jira.agentTools']} writes={st?.writes === true} />
      </Row>
      <Row name={T.browser.name} isNew desc={T.browser.desc} k="browser.enabled">
        <Toggle k="browser.enabled" value={v['browser.enabled']} />
      </Row>
    </>
  );
}

/** Варианты карточек: подпись — начало подписи варианта («журнал — как раньше» → «журнал»). */
const cardOptions = <V extends string>(modes: readonly V[], labels: Record<string, string>) =>
  modes.map((m): [V, string] => [m, (labels[m] ?? m).split(' — ')[0] ?? m]);

/** Первое имя из font-family VS Code — для подсказки в пустом поле шрифта. */
function vscodeFont(cssVar: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
  return (v.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Шрифт карточками: «как в VS Code», установленные из популярных и текущий свой (если его нет в списке).
 * Каждая карточка нарисована своим шрифтом; наведение примеряет шрифт на образец ленты (`onTry`).
 */
type FontKey = 'font.interface' | 'font.panels' | 'font.code';

/** Переменная CSS каждого шрифта и запасной шрифт (`fontStack`); у панелей пусто — прежние шрифты. */
const FONT_VARS: Record<FontKey, [string, string]> = {
  'font.interface': ['--font', 'var(--font-vscode)'],
  'font.panels': ['--panel-font', 'var(--font-vscode)'],
  'font.code': ['--mono', 'var(--mono-vscode)'],
};

function FontCards({
  k,
  value,
  candidates,
  defaultLabel,
  fallback,
  sample,
  onTry,
  addKind,
}: {
  k: FontKey;
  value: string;
  candidates: readonly string[];
  /** Подпись карточки «пусто». */
  defaultLabel: string;
  fallback: string;
  sample: string;
  onTry: (name: string | undefined) => void;
  /** Для чего добавляется шрифт из Google Fonts (`panels` — из всех семейств); нет — без кнопки. */
  addKind?: 'ui' | 'code' | 'panels';
}) {
  const fonts = installedFonts(candidates);
  const user = userFonts.value;
  const own = value.trim();
  if (own && !fonts.includes(own)) fonts.push(own);
  const options: [string, string][] = [
    ['', defaultLabel],
    ...fonts.map((f): [string, string] => [f, f === 'system-ui' ? T.fontSystem : f]),
  ];
  return (
    <>
      <ChoiceCards
        kind="fonts"
        label={k}
        value={own}
        options={options}
        preview={(f) => (
          <span class="fs" style={{ fontFamily: fontStack(f, fallback) ?? fallback }}>
            {sample}
          </span>
        )}
        onPick={(f) => commit(k, f)}
        onTry={onTry}
        removable={{
          has: (f) => user.ui.includes(f) || user.code.includes(f),
          label: T.fontRemove,
          onRemove: removeFont,
        }}
      />
      {addKind && (
        <button type="button" class="fonts-add" onClick={() => addFont(addKind)}>
          {T.fontAdd}
        </button>
      )}
    </>
  );
}

function FontSizeSelect({
  value,
  k = 'feed.fontSize',
}: {
  value: number;
  k?: 'feed.fontSize' | 'ui.fontSize';
}) {
  void errors.value[k];
  const sizes: number[] = [];
  for (let n = MIN_FEED_FONT_SIZE; n <= MAX_FEED_FONT_SIZE; n++) sizes.push(n);
  return (
    <span class="dd">
      <select
        aria-label={k}
        value={String(value)}
        onChange={(e) => commit(k, Number((e.currentTarget as HTMLSelectElement).value))}
      >
        {sizes.map((n) => (
          <option key={n} value={String(n)}>
            {n === DEFAULT_FEED_FONT_SIZE ? `${n} px — ${T.feedFontSize.def}` : `${n} px`}
          </option>
        ))}
      </select>
    </span>
  );
}

function DiffFontSizeSelect({ value }: { value: number }) {
  void errors.value['diff.fontSize'];
  // 0 (как лента), 8…24 и круглые крупные; значение вне списка (из settings.json) — отдельной строкой
  const sizes = [0, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, MAX_DIFF_FONT_SIZE];
  if (!sizes.includes(value)) sizes.push(value);
  sizes.sort((a, b) => a - b);
  return (
    <span class="dd">
      <select
        aria-label="diff.fontSize"
        value={String(value)}
        onChange={(e) => commit('diff.fontSize', Number((e.currentTarget as HTMLSelectElement).value))}
      >
        {sizes.map((n) => (
          <option key={n} value={String(n)}>
            {n === 0 ? T.diffFontSize.same : `${n} px`}
          </option>
        ))}
      </select>
    </span>
  );
}

function PollField({ value }: { value: number }) {
  const [draft, setDraft] = useDraft(String(value));
  const send = (text: string) => {
    const n = text.trim() === '' ? NaN : Number(text);
    if (n === value) {
      setError('usagePollMinutes', undefined); // вернули прежнее значение — ошибка неактуальна
      return;
    }
    // проверка до отправки (та же, что на хосте; хост проверит ещё раз)
    const checked = validateSetting('usagePollMinutes', n, uiLang);
    if (!checked.ok) {
      setError('usagePollMinutes', checked.error);
      return;
    }
    commit('usagePollMinutes', n);
  };
  return (
    <input
      class="num"
      type="number"
      min={MIN_POLL_MINUTES}
      max={MAX_POLL_MINUTES}
      step={1}
      aria-label="usagePollMinutes"
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onChange={(e) => send((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') send((e.currentTarget as HTMLInputElement).value);
      }}
    />
  );
}

function Thresholds({ value }: { value: [number, number] }) {
  // черновик на поле: state после записи жёлтого не стирает недонабранный оранжевый
  const [y, setY] = useDraft(String(value[0]));
  const [o, setO] = useDraft(String(value[1]));
  const send = (i: 0 | 1, text: string) => {
    const d = i === 0 ? [text, o] : [y, text];
    const nums = d.map((t) => (t.trim() === '' ? NaN : Number(t)));
    const err = thresholdsError(nums, uiLang);
    if (err) {
      setError('contextThresholds', err);
      return;
    }
    if (nums[0] !== value[0] || nums[1] !== value[1]) commit('contextThresholds', nums);
    else setError('contextThresholds', undefined);
  };
  const field = (i: 0 | 1, label: string) => (
    <>
      <span class="u">{label}</span>
      <input
        class="num"
        type="number"
        min={1}
        step={1000}
        aria-label={`${label}`}
        value={i === 0 ? y : o}
        onInput={(e) => (i === 0 ? setY : setO)((e.currentTarget as HTMLInputElement).value)}
        onChange={(e) => send(i, (e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') send(i, (e.currentTarget as HTMLInputElement).value);
        }}
      />
    </>
  );
  return (
    <>
      {field(0, T.thresholds.yellow)}
      {field(1, T.thresholds.orange)}
    </>
  );
}

function ThresholdScale({ value }: { value: [number, number] }) {
  const [y, o] = value;
  const ok = thresholdsError(value, uiLang) === undefined;
  const cells = Array.from({ length: 20 }, (_, i) => {
    const from = i * 10_000;
    const cls = i === 19 ? 'f' : ok && from >= o ? 'h' : ok && from >= y ? 'w' : '';
    return <i key={i} class={cls} />;
  });
  return (
    <>
      <div class="th" aria-hidden="true">
        {cells}
      </div>
      <div class="thl">
        <span>0</span>
        <span>{Math.round(y / 1000)}k</span>
        <span style="display:flex;justify-content:space-between">
          <span>{Math.round(o / 1000)}k</span>
          <span>{T.thresholds.compress}</span>
        </span>
      </div>
    </>
  );
}

type EngineId = 'claude' | 'codex' | 'antigravity' | 'cursor';
const ENGINE_KEY = {
  claude: 'claudeExecutable',
  codex: 'codexExecutable',
  antigravity: 'antigravityExecutable',
  cursor: 'cursorExecutable',
} as const;

function EngineRow({ value, engine = 'claude' }: { value: string; engine?: EngineId }) {
  const [draft, setDraft] = useDraft(value);
  const k = ENGINE_KEY[engine];
  const text =
    engine === 'codex' ? T.exeCodex : engine === 'antigravity' ? T.exeAgy : engine === 'cursor' ? T.exeCursor : T.exe;
  const c = (
    engine === 'codex' ? codexCheck : engine === 'antigravity' ? agyCheck : engine === 'cursor' ? cursorCheck : engineCheck
  ).value;
  const r = c.result;
  const save = (text: string) => {
    if (text.trim() !== value) commit(k, text);
    else setError(k, undefined);
  };
  return (
    <Row name={text.name} desc={text.desc} k={k} machine below={checkLine()}>
      <input
        class="num wide"
        type="text"
        aria-label={k}
        value={draft}
        placeholder={text.placeholder}
        spellcheck={false}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onChange={(e) => save((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save((e.currentTarget as HTMLInputElement).value);
        }}
      />
      <button
        type="button"
        class="btn"
        disabled={c.pending}
        onClick={() => checkEngine(draft, engine)}
      >
        {c.pending ? T.exe.checking : T.exe.check}
      </button>
    </Row>
  );

  function checkLine() {
    if (!r) return null;
    const src = T.exe.source[r.source];
    return (
      <div class={r.ok ? 'ok' : 'ok bad'} role="status">
        {r.ok ? '✓ ' : '✗ '}
        {r.ok ? T.exe.found : T.exe.notFound}
        {r.path ? <span class="dim"> {r.path}</span> : null}
        {r.version ? ` · ${r.version}` : ''}
        {src ? ` · ${src}` : ''}
        {r.problem ? <div class="dim">{r.problem}</div> : null}
      </div>
    );
  }
}

export function Settings() {
  const v = settingsValues.value;
  const [active, setActive] = useState<Section>(readSettingsSection);
  const [settingsProvider, setSettingsProvider] = useState<AgentProvider>();
  const selectedProvider = settingsProvider ?? v?.defaultProvider ?? 'claude';
  const selectProvider = (provider: AgentProvider) => {
    setSettingsProvider(provider);
    document.getElementById(`ns-tab-${provider}`)?.focus();
  };
  const providerHasError = (provider: AgentProvider) => sessionKeys[provider].some(k => errors.value[k])
    || (provider === 'codex' && !!codexModels.value.error)
    || (provider === 'antigravity' && !!antigravityModels.value.error);
  // примерка шрифта (наведение на карточку): образец ленты рисуется им, настройка не меняется
  const [trying, setTrying] = useState<{ k: FontKey; name: string }>();
  const tryFont = (k: FontKey) => (name: string | undefined) =>
    setTrying(name === undefined ? undefined : { k, name });
  const body = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);

  // hud.css переключает вёрстку по html[data-width]; в узком сплите разделы — полосой над страницей
  useEffect(() => {
    const apply = () =>
      document.documentElement.setAttribute(
        'data-width',
        window.innerWidth / uiZoom() < NAV_PX ? '380' : '900',
      );
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  const go = (id: Section, focus = false) => {
    setActive(id);
    saveSettingsSection(id);
    if (body.current) body.current.scrollTop = 0;
    if (focus) nav.current?.querySelector<HTMLElement>(`[data-section="${id}"]`)?.focus();
  };
  // хост открыл настройки сразу на разделе (ссылка «настройки поиска →» из вкладки «код»)
  const wanted = requestedSection.value;
  useEffect(() => {
    if (!wanted) return;
    requestedSection.value = undefined;
    go(wanted);
  }, [wanted]);
  // стрелки, Home, End — как у вкладок (role="tablist")
  const onNavKey = (e: KeyboardEvent) => {
    const i = SECTIONS.indexOf(active);
    const to =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? SECTIONS[(i + 1) % SECTIONS.length]
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? SECTIONS[(i - 1 + SECTIONS.length) % SECTIONS.length]
          : e.key === 'Home'
            ? SECTIONS[0]
            : e.key === 'End'
              ? SECTIONS[SECTIONS.length - 1]
              : undefined;
    if (!to) return;
    e.preventDefault();
    go(to, true);
  };

  if (!v) return <div class="webview settings" aria-busy="true" />;

  const modes: [string, string][] = ['manual', 'acceptEdits', 'plan']
    .concat(
      v.allowBypassPermissions || v.defaultPermissionMode === 'bypassPermissions'
        ? ['bypassPermissions']
        : [],
    )
    .map((m) => [m, T.mode.options[m] ?? m]);
  const efforts: [string, string][] = [
    ['', T.effort.engine],
    ...EFFORT_LEVELS.map((e): [string, string] => [e, S.efforts[e]]),
  ];
  const catalog = codexModels.value;
  const codexModel = catalog.models.find((m) => m.value === v['codex.defaultModel']);
  const codexModelOptions: [string, string, boolean?][] = [
    ['', T.newChat.inherit], ...catalog.models.map((m): [string, string] => [m.value, m.displayName]),
  ];
  if (v['codex.defaultModel'] && !codexModel) codexModelOptions.push([
    v['codex.defaultModel'], `${v['codex.defaultModel']}${catalog.loading ? '' : ` (${T.newChat.unavailable})`}`, true,
  ]);
  const codexEfforts: [string, string, boolean?][] = [
    ['', T.newChat.inherit], ...(codexModel?.effortLevels ?? []).map((e): [string, string] => [e, S.efforts[e]]),
  ];
  if (v['codex.defaultEffort'] && !codexModel?.effortLevels?.includes(v['codex.defaultEffort']))
    codexEfforts.push([v['codex.defaultEffort'], `${v['codex.defaultEffort']} (${T.newChat.unavailable})`, true]);

  const agyCatalog = antigravityModels.value;
  const agyModel = agyCatalog.models.find((m) => m.value === v['antigravity.defaultModel']);
  const agyModelOptions: [string, string, boolean?][] = [
    ['', T.newChat.inherit], ...agyCatalog.models.map((m): [string, string] => [m.value, m.displayName]),
  ];
  if (v['antigravity.defaultModel'] && !agyModel) agyModelOptions.push([
    v['antigravity.defaultModel'], `${v['antigravity.defaultModel']}${agyCatalog.loading ? '' : ` (${T.newChat.unavailable})`}`, true,
  ]);
  const agyModelSupportsEffort = agyModel ? (agyModel.supportsEffort ?? (agyModel.effortLevels && agyModel.effortLevels.length > 0)) : true;
  const agyEfforts: [string, string, boolean?][] = [
    ['', S.agyDefaultEffort],
    ['low', S.efforts.low],
    ['medium', S.efforts.medium],
    ['high', S.efforts.high],
  ];
  if (v['antigravity.defaultEffort'] && !['', 'low', 'medium', 'high'].includes(v['antigravity.defaultEffort']))
    agyEfforts.push([v['antigravity.defaultEffort'], `${v['antigravity.defaultEffort']} (${T.newChat.unavailable})`, true]);

  // примеряемый шрифт перекрывает свою переменную только у образцов; '' — значение по умолчанию
  // (у панелей — `initial`: var(--panel-font, …) берёт прежний шрифт)
  const trialVars = trying
    ? (() => {
        const [cssVar, base] = FONT_VARS[trying.k];
        const empty = trying.k === 'font.panels' ? 'initial' : base;
        return { [cssVar]: fontStack(trying.name, base) ?? empty };
      })()
    : undefined;
  const trialCap = trying
    ? T.sampleTrying(
        trying.name || (trying.k === 'font.panels' ? T.fontAsBefore : T.fontVscode('')),
      )
    : T.sample;
  const look = {
    top: v['sidebar.top'],
    list: v['sessionList.view'],
    context: v['sessionList.context'],
    time: v['sessionList.time'],
  };
  const providers: [string, string][] = [
    ['claude', T.provider.options.claude],
    ['codex', T.provider.options.codex],
    ['antigravity', T.provider.options.antigravity],
    ['cursor', T.provider.options.cursor],
  ];
  const languageModes = LANGUAGE_MODES.map((m): [string, string] => [
    m,
    T.language.options[m] ?? m,
  ]);

  // все страницы в DOM, видна одна: черновик поля переживает переход в другой раздел и обратно
  const page = (id: Section, children: ComponentChildren) => (
    <section
      class="st-page"
      id={id}
      role="tabpanel"
      aria-labelledby={`st-tab-${id}`}
      hidden={active !== id}
    >
      {id !== 'session' && <h2>{T.sections[id]}</h2>}
      {children}
    </section>
  );

  const ver = extensionVersion.value?.trim();

  return (
    <div class="webview settings">
      <header class="hud" aria-label={T.aria}>
        <span class="sess" style="display:block;padding-left:8px">
          Agentura · <b>{T.title.toLowerCase()}</b>
          {ver ? <span class="st-ver">v{ver}</span> : null}
        </span>
        <span class="acts">
          <button type="button" data-tip={T.openUiTitle} onClick={() => reveal('ui')}>
            {T.openUi}
          </button>
          <button type="button" data-tip={T.openJsonTitle} onClick={() => reveal('json')}>
            {T.openJson}
          </button>
        </span>
      </header>

      <div class="st-wrap">
        <nav class="st-nav" aria-label={T.navAria} ref={nav}>
          <div class="st-tabs" role="tablist" aria-orientation="vertical" onKeyDown={onNavKey}>
            {SECTIONS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`st-tab-${id}`}
                data-section={id}
                aria-controls={id}
                aria-selected={active === id}
                tabIndex={active === id ? 0 : -1}
                class={active === id ? 'on' : ''}
                onClick={() => go(id)}
              >
                {T.sections[id]}
              </button>
            ))}
          </div>
          <div class="src">
            {T.source}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                reveal('json');
              }}
            >
              {T.openJsonLink}
            </a>
          </div>
        </nav>

        <div class="st-body" ref={body}>
          {page(
            'session',
            <>
              <div class="ns-heading">
                <span class="ns-eyebrow">{S.eyebrow}</span>
                <h2>{S.title}</h2><p>{S.note}</p>
              </div>
              <div class="ns-providers" role="tablist" aria-label={S.tabs}>
                {sessionProviders.map(([id, name, vendor]) => (
                  <button type="button" role="tab" id={`ns-tab-${id}`} aria-controls={`ns-panel-${id}`}
                    aria-selected={selectedProvider === id} tabIndex={selectedProvider === id ? 0 : -1}
                    data-provider={id} onClick={() => setSettingsProvider(id)}
                    onKeyDown={(e) => {
                      const i = sessionProviders.findIndex(([p]) => p === id);
                      const next = e.key === 'ArrowRight' ? (i + 1) % 4 : e.key === 'ArrowLeft' ? (i + 3) % 4
                        : e.key === 'Home' ? 0 : e.key === 'End' ? 3 : -1;
                      if (next < 0) return;
                      e.preventDefault();
                      const nextProvider = sessionProviders[next];
                      if (nextProvider) selectProvider(nextProvider[0]);
                    }}>
                    <span class={`ns-logo ns-logo-${id}`} aria-hidden="true" />
                    <strong>{name}</strong><small>{vendor}</small>
                    <span class="ns-default" hidden={v.defaultProvider !== id}>{S.defaultBadge}</span>
                    {providerHasError(id) && <span class="ns-provider-error" role="status">!</span>}
                  </button>
                ))}
              </div>
              <div class="ns-panel-head">
                <div><h3>{sessionProviders.find(([id]) => id === selectedProvider)?.[1]}</h3>
                  <p>{v.defaultProvider === selectedProvider ? S.isDefault : S.notDefault}</p></div>
                {v.defaultProvider !== selectedProvider && <button type="button" class="btn ns-button"
                  onClick={() => { commit('defaultProvider', selectedProvider); selectProvider(selectedProvider); }}>{S.makeDefault}</button>}
              </div>
              {overridden.value.includes('defaultProvider') && <div class="note">{T.overridden}</div>}
              {errors.value.defaultProvider && <div class="err" role="alert">{errors.value.defaultProvider}</div>}
              <div id="ns-panel-claude" role="tabpanel" aria-labelledby="ns-tab-claude" hidden={selectedProvider !== 'claude'}>
                <div class="ns-group"><h4>{S.modelGroup}</h4>
                  <Row name={S.model} desc={T.model.desc} k="defaultModel">
                    <TextField k="defaultModel" value={v.defaultModel} placeholder={T.model.placeholder} />
                  </Row>
                  <Row name={S.effort} desc={S.effortDesc} k="defaultEffort">
                    <Select k="defaultEffort" value={v.defaultEffort} options={efforts} />
                  </Row>
                </div>
                <div class="ns-group ns-mode"><h4>{S.modeGroup}</h4>
                  <Row name={T.mode.name} desc={S.modeDesc} k="defaultPermissionMode">
                    <div class="ns-permissions" role="radiogroup" aria-label="defaultPermissionMode">
                      {modes.map(([value]) => <label class="ns-choice" key={value}>
                        <input type="radio" name="defaultPermissionMode" value={value} checked={v.defaultPermissionMode === value}
                          onChange={() => commit('defaultPermissionMode', value)} />
                        <span><strong>{S.modes[value as keyof typeof S.modes]}</strong>
                          <small>{S.modeNotes[value as keyof typeof S.modeNotes]}</small></span>
                      </label>)}
                    </div>
                  </Row>
                </div>
                <div class="ns-group"><h4>{S.remoteGroup}</h4>
                  <Row name={S.remote} desc={S.remoteDesc} k="remoteControl" keyNote={T.remoteControl.keyNote}>
                    <Toggle k="remoteControl" value={v.remoteControl} />
                  </Row>
                  <div hidden={!v.remoteControl && !errors.value.remoteControlNamePrefix && !overridden.value.includes('remoteControlNamePrefix')}>
                    <Row name={T.remoteControlNamePrefix.name} desc={T.remoteControlNamePrefix.desc} k="remoteControlNamePrefix">
                      <TextField k="remoteControlNamePrefix" value={v.remoteControlNamePrefix} placeholder={T.remoteControlNamePrefix.placeholder} wide />
                    </Row>
                  </div>
                </div>
              </div>
              <div id="ns-panel-codex" role="tabpanel" aria-labelledby="ns-tab-codex" hidden={selectedProvider !== 'codex'}>
                <div class="ns-group"><h4>{S.modelGroup}</h4>
                  <Row name={S.model} desc={T.newChat.modelDesc} k="codex.defaultModel">
                    <Select k="codex.defaultModel" value={v['codex.defaultModel']} options={codexModelOptions} disabled={catalog.loading} />
                    <button type="button" class="btn" disabled={catalog.loading} onClick={() => send({ type: 'settings.codexModels' })}>
                      {catalog.loading ? T.newChat.modelsLoading : T.newChat.modelsReload}
                    </button>
                  </Row>
                  {!catalog.loading && (catalog.error || !catalog.models.length) &&
                    <div class="err" role="alert">{catalog.error ?? T.newChat.noModels}</div>}
                  <Row name={S.effort} desc={T.newChat.effortDesc} k="codex.defaultEffort">
                    <Select k="codex.defaultEffort" value={v['codex.defaultEffort']} options={codexEfforts} disabled={catalog.loading || !codexModel} />
                  </Row>
                </div>
                <div class="ns-group"><h4>{S.permissions}</h4>
                  <Row name={S.approval} desc={S.approvalDesc} k="codex.defaultApproval">
                    <Select k="codex.defaultApproval" value={v['codex.defaultApproval']} options={[
                      ['', T.newChat.inherit], ['untrusted', S.approvals.untrusted], ['on-request', S.approvals['on-request']], ['never', S.approvals.never],
                    ]} />
                  </Row>
                  <Row name={S.sandbox} desc={S.sandboxDesc} k="codex.defaultSandbox">
                    <Select k="codex.defaultSandbox" value={v['codex.defaultSandbox']} options={[
                      ['', T.newChat.inherit], ['readOnly', T.newChat.readOnly], ['workspaceWrite', T.newChat.workspaceWrite],
                      ...(v.allowBypassPermissions || v['codex.defaultSandbox'] === 'dangerFullAccess'
                        ? [['dangerFullAccess', T.newChat.dangerFullAccess] as [string, string]] : []),
                    ]} />
                  </Row>
                  {v['codex.defaultSandbox'] === 'dangerFullAccess' ? <p>{S.fullHint}</p>
                    : v['codex.defaultApproval'] === 'never' && v['codex.defaultSandbox'] !== '' ? <p>{S.neverHint}</p> : null}
                </div>
              </div>
              <div id="ns-panel-cursor" role="tabpanel" aria-labelledby="ns-tab-cursor" hidden={selectedProvider !== 'cursor'}>
                <div class="ns-group"><h4>{S.model}</h4>
                  <Row name={S.model} desc={T.model.cursorDesc} k="cursor.defaultModel">
                    <TextField k="cursor.defaultModel" value={v['cursor.defaultModel']} placeholder={T.model.cursorPlaceholder} />
                  </Row>
                  <p>{S.sharedMode}</p><button type="button" class="ns-link" onClick={() => selectProvider('claude')}>{S.openClaude}</button>
                </div>
              </div>
              <div id="ns-panel-antigravity" role="tabpanel" aria-labelledby="ns-tab-antigravity" hidden={selectedProvider !== 'antigravity'}>
                <div class="ns-group"><h4>{S.modelGroup}</h4>
                  <Row name={S.model} desc={T.newChat.modelDesc} k="antigravity.defaultModel">
                    {agyCatalog.models.length > 0 ? (
                      <Select k="antigravity.defaultModel" value={v['antigravity.defaultModel']} options={agyModelOptions} disabled={agyCatalog.loading} />
                    ) : (
                      <TextField k="antigravity.defaultModel" value={v['antigravity.defaultModel']} placeholder="gemini-3.8-flash" />
                    )}
                    <button type="button" class="btn" disabled={agyCatalog.loading} onClick={() => send({ type: 'settings.antigravityModels' })}>
                      {agyCatalog.loading ? T.newChat.modelsLoading : T.newChat.modelsReload}
                    </button>
                  </Row>
                  {!agyCatalog.loading && (agyCatalog.error || !agyCatalog.models.length) &&
                    <div class="err" role="alert">{agyCatalog.error ?? T.newChat.noModels}</div>}
                  <Row name={S.effort} desc={T.newChat.effortDesc} k="antigravity.defaultEffort">
                    <Select k="antigravity.defaultEffort" value={v['antigravity.defaultEffort']} options={agyEfforts} disabled={agyCatalog.loading || !agyModelSupportsEffort} />
                  </Row>
                  <p>{S.sharedMode}</p>
                  <button type="button" class="ns-link" onClick={() => selectProvider('claude')}>{S.openClaude}</button>
                </div>
              </div>
              <details class="ns-advanced" open={errors.value.allowBypassPermissions || overridden.value.includes('allowBypassPermissions') ? true : undefined}>
                <summary>{S.advanced}<span>{S.advancedNote}</span></summary>
                <Row name={S.unlock} desc={S.unlockDesc} k="allowBypassPermissions" machine
                  below={<div class="warn"><b>{T.bypass.warnTitle}</b>{T.bypass.warn}</div>}>
                  <Toggle k="allowBypassPermissions" value={v.allowBypassPermissions} danger />
                </Row>
                {!v.allowBypassPermissions && (v.defaultPermissionMode === 'bypassPermissions' || v['codex.defaultSandbox'] === 'dangerFullAccess') && <p>{S.savedAccess}</p>}
                <div class="ns-keys">{['defaultProvider', ...sessionKeys[selectedProvider], 'allowBypassPermissions'].map(k => <div key={k}>agentura.{k}</div>)}</div>
              </details>
            </>,
          )}

          {page(
            'limits',
            <>
              <Row
                name={T.thresholds.name}
                desc={T.thresholds.desc}
                k="contextThresholds"
                below={<ThresholdScale value={v.contextThresholds} />}
              >
                <Thresholds value={v.contextThresholds} />
              </Row>
              <Row
                name={T.poll.name}
                desc={T.poll.desc}
                k="usagePollMinutes"
                keyNote={T.poll.noLess}
              >
                <PollField value={v.usagePollMinutes} />
                <span class="u">{T.poll.unit}</span>
              </Row>
              <Row name={T.keychain.name} desc={T.keychain.desc} k="limits.readKeychain">
                <Toggle k="limits.readKeychain" value={v['limits.readKeychain']} />
              </Row>
            </>,
          )}

          {page(
            'sidebar',
            <>
              <Row
                name={T.sidebarTop.name}
                isNew
                desc={T.sidebarTop.desc}
                k="sidebar.top"
                below={
                  <ChoiceCards
                    label={T.sidebarTop.name}
                    value={v['sidebar.top']}
                    options={cardOptions(SIDEBAR_TOP_MODES, T.sidebarTop.options)}
                    preview={(top) => <SidebarPreview look={{ ...look, top }} part="top" />}
                    onPick={(top) => commit('sidebar.top', top)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.sidebarLimits.name}
                isNew
                desc={T.sidebarLimits.desc}
                k="sidebar.limits"
                below={
                  <ChoiceCards
                    label={T.sidebarLimits.name}
                    value={v['sidebar.limits']}
                    options={cardOptions(SIDEBAR_LIMITS_MODES, T.sidebarLimits.options)}
                    preview={(limits) => (
                      <SidebarPreview look={{ ...look, top: 'detailed', limits }} part="limits" />
                    )}
                    onPick={(limits) => commit('sidebar.limits', limits)}
                  />
                }
              >
                {null}
              </Row>
              <Row name={T.limitsHidden.name} isNew desc={T.limitsHidden.desc} k="sidebar.limitsHidden">
                <HiddenEnginesBoxes value={v['sidebar.limitsHidden']} />
              </Row>
              <Row
                name={T.tasksSidebar.name}
                isNew
                desc={T.tasksSidebar.desc}
                k="tasks.sidebar"
                below={
                  <ChoiceCards
                    label={T.tasksSidebar.name}
                    value={v['tasks.sidebar']}
                    options={cardOptions(TASK_SIDEBAR_MODES, T.tasksSidebar.options)}
                    preview={(tasks) => <SidebarPreview look={{ ...look, tasks }} part="tasks" />}
                    onPick={(tasks) => commit('tasks.sidebar', tasks)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.listView.name}
                isNew
                desc={T.listView.desc}
                k="sessionList.view"
                below={
                  <ChoiceCards
                    label={T.listView.name}
                    value={v['sessionList.view']}
                    options={cardOptions(SESSION_LIST_MODES, T.listView.options)}
                    preview={(list) => <SidebarPreview look={{ ...look, list }} part="list" />}
                    onPick={(list) => commit('sessionList.view', list)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.listContext.name}
                isNew
                desc={T.listContext.desc}
                k="sessionList.context"
              >
                <Toggle k="sessionList.context" value={v['sessionList.context']} />
              </Row>
              <Row name={T.listTime.name} isNew desc={T.listTime.desc} k="sessionList.time">
                <Toggle k="sessionList.time" value={v['sessionList.time']} />
              </Row>
            </>,
          )}

          {page(
            'look',
            <>
              <Row
                name={T.feedStyle.name}
                isNew
                desc={T.feedStyle.desc}
                k="feed.style"
                below={
                  <ChoiceCards
                    label={T.feedStyle.name}
                    value={v['feed.style']}
                    options={cardOptions(FEED_STYLES, T.feedStyle.options)}
                    preview={(style) => <FeedPreview style={style} />}
                    onPick={(style) => commit('feed.style', style)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.composerLayout.name}
                isNew
                desc={T.composerLayout.desc}
                k="composer.layout"
                below={
                  <ChoiceCards
                    label={T.composerLayout.name}
                    value={v['composer.layout']}
                    options={cardOptions(COMPOSER_LAYOUTS, T.composerLayout.options)}
                    preview={(layout) => <ComposerPreview layout={layout} />}
                    onPick={(layout) => commit('composer.layout', layout)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.agentsView.name}
                isNew
                desc={T.agentsView.desc}
                k="agents.view"
                below={
                  <ChoiceCards
                    label={T.agentsView.name}
                    value={v['agents.view']}
                    options={cardOptions(AGENTS_VIEWS, T.agentsView.options)}
                    preview={(view) => <AgentsPreview view={view} />}
                    onPick={(view) => commit('agents.view', view)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.gitLayout.name}
                isNew
                desc={T.gitLayout.desc}
                k="git.layout"
                below={
                  <ChoiceCards
                    label={T.gitLayout.name}
                    value={v['git.layout']}
                    options={cardOptions(GIT_LAYOUTS, T.gitLayout.options)}
                    preview={(layout) => <GitPreview layout={layout} />}
                    onPick={(layout) => commit('git.layout', layout)}
                  />
                }
              >
                {null}
              </Row>
              <Row name={T.gitHideClean.name} isNew desc={T.gitHideClean.desc} k="git.hideClean">
                <Toggle k="git.hideClean" value={v['git.hideClean']} />
              </Row>
              <Row
                name={T.tasksCard.name}
                isNew
                desc={T.tasksCard.desc}
                k="tasks.card"
                below={
                  <ChoiceCards
                    label={T.tasksCard.name}
                    value={v['tasks.card']}
                    options={cardOptions(TASK_CARD_MODES, T.tasksCard.options)}
                    preview={(mode) => <TaskCardPreview mode={mode} />}
                    onPick={(mode) => commit('tasks.card', mode)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.tasksTab.name}
                isNew
                desc={T.tasksTab.desc}
                k="tasks.tab"
                below={
                  <ChoiceCards
                    label={T.tasksTab.name}
                    value={v['tasks.tab']}
                    options={cardOptions(TASK_TAB_MODES, T.tasksTab.options)}
                    preview={(mode) => <TaskTabPreview mode={mode} />}
                    onPick={(mode) => commit('tasks.tab', mode)}
                  />
                }
              >
                {null}
              </Row>
              <Row
                name={T.feedFontSize.name}
                isNew
                desc={T.feedFontSize.desc}
                k="feed.fontSize"
                below={
                  <div class="pv-one" style={trialVars}>
                    <span class="pv-cap">{trialCap}</span>
                    <FeedPreview style={v['feed.style']} scaled />
                  </div>
                }
              >
                <FontSizeSelect value={v['feed.fontSize']} />
              </Row>
              <Row name={T.uiFontSize.name} isNew desc={T.uiFontSize.desc} k="ui.fontSize">
                <FontSizeSelect value={v['ui.fontSize']} k="ui.fontSize" />
              </Row>
              <Row name={T.uiAnimations.name} isNew desc={T.uiAnimations.desc} k="ui.animations">
                <Toggle k="ui.animations" value={v['ui.animations']} />
              </Row>
              <Row name={T.diffHighlight.name} isNew desc={T.diffHighlight.desc} k="diff.syntaxHighlighting">
                <Toggle k="diff.syntaxHighlighting" value={v['diff.syntaxHighlighting']} />
              </Row>
              <Row name={T.diffTheme.name} isNew desc={T.diffTheme.desc} k="diff.highlightTheme">
                <Select
                  k="diff.highlightTheme"
                  value={v['diff.highlightTheme']}
                  options={HIGHLIGHT_THEMES.map((m) => [m, T.diffTheme.options[m] ?? m] as const)}
                />
              </Row>
              <Row name={T.diffFontSize.name} isNew desc={T.diffFontSize.desc} k="diff.fontSize">
                <DiffFontSizeSelect value={v['diff.fontSize']} />
              </Row>
              <Row
                name={T.fontInterface.name}
                isNew
                desc={T.fontInterface.desc}
                k="font.interface"
                below={
                  <FontCards
                    k="font.interface"
                    value={v['font.interface']}
                    candidates={uiFonts()}
                    addKind="ui"
                    defaultLabel={T.fontVscode(vscodeFont('--vscode-font-family'))}
                    fallback="var(--font-vscode)"
                    sample={T.fontSampleUi}
                    onTry={tryFont('font.interface')}
                  />
                }
              >
                <TextField k="font.interface" value={v['font.interface']} placeholder={T.fontOwn} />
              </Row>
              <Row
                name={T.fontPanels.name}
                isNew
                desc={T.fontPanels.desc}
                k="font.panels"
                below={
                  <>
                    <FontCards
                      k="font.panels"
                      value={v['font.panels']}
                      candidates={[...uiFonts(), ...codeFonts()]}
                      addKind="panels"
                      defaultLabel={T.fontAsBefore}
                      fallback="var(--mono)"
                      sample={T.fontSamplePanels}
                      onTry={tryFont('font.panels')}
                    />
                    <div class="pv-one pv-panels" style={trialVars}>
                      <span class="pv-cap">{trialCap}</span>
                      <SidebarPreview look={look} part="top" />
                    </div>
                  </>
                }
              >
                <TextField k="font.panels" value={v['font.panels']} placeholder={T.fontOwn} />
              </Row>
              <Row
                name={T.fontCode.name}
                isNew
                desc={T.fontCode.desc}
                k="font.code"
                below={
                  <FontCards
                    k="font.code"
                    value={v['font.code']}
                    candidates={codeFonts()}
                    addKind="code"
                    defaultLabel={T.fontVscode(vscodeFont('--vscode-editor-font-family'))}
                    fallback="var(--mono-vscode)"
                    sample={T.fontSampleCode}
                    onTry={tryFont('font.code')}
                  />
                }
              >
                <TextField k="font.code" value={v['font.code']} placeholder={T.fontOwn} />
              </Row>
              <Row name={T.language.name} isNew desc={T.language.desc} k="language">
                <Select k="language" value={v.language} options={languageModes} />
              </Row>
              <h3 class="st-sub">{T.mcpGroup.title}</h3>
              <p class="st-subnote">{T.mcpGroup.note}</p>
              <Row name={T.mcpFeedLabels.name} isNew desc={T.mcpFeedLabels.desc} k="mcp.feedLabels">
                <Toggle k="mcp.feedLabels" value={v['mcp.feedLabels']} />
              </Row>
              <Row
                name={T.mcpComposerButton.name}
                isNew
                desc={T.mcpComposerButton.desc}
                k="mcp.composerButton"
              >
                <Toggle k="mcp.composerButton" value={v['mcp.composerButton']} />
              </Row>
              <Row name={T.mcpPanelTab.name} isNew desc={T.mcpPanelTab.desc} k="mcp.panelTab">
                <Toggle k="mcp.panelTab" value={v['mcp.panelTab']} />
              </Row>
              <Row name={T.mcpFeedStatus.name} isNew desc={T.mcpFeedStatus.desc} k="mcp.feedStatus">
                <Select
                  k="mcp.feedStatus"
                  value={v['mcp.feedStatus']}
                  options={MCP_FEED_STATUS_MODES.map((m) => [m, T.mcpFeedStatus.options[m] ?? m] as const)}
                />
              </Row>
            </>,
          )}

          {page('integrations', <IntegrationsRows v={v} />)}

          {page(
            'engine',
            <>
              <Row name={T.provider.name} isNew desc={T.provider.desc} k="defaultProvider">
                <Select k="defaultProvider" value={v.defaultProvider} options={providers} />
              </Row>
              <EngineRow value={v.claudeExecutable} />
              <EngineRow engine="codex" value={v.codexExecutable} />
              <EngineRow engine="antigravity" value={v.antigravityExecutable} />
              <EngineRow engine="cursor" value={v.cursorExecutable} />
            </>,
          )}
        </div>
      </div>
    </div>
  );
}
