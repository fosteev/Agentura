import { uiZoom } from '../appearance';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  EFFORT_LEVELS,
  LANGUAGE_MODES,
  MAX_POLL_MINUTES,
  MIN_POLL_MINUTES,
  SESSION_LIST_MODES,
  SIDEBAR_LIMITS_MODES,
  JIRA_SOURCES,
  TASK_CARD_MODES,
  TASK_REFRESH_MODES,
  TASK_SIDEBAR_MODES,
  SIDEBAR_TOP_MODES,
  COMPOSER_LAYOUTS,
  FEED_STYLES,
  AGENTS_VIEWS,
  GIT_LAYOUTS,
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
  engineCheck,
  errors,
  integrations,
  integrationsAction,
  overridden,
  removeFont,
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
} from './SettingsPreview';
import { fontStack } from '../appearance';
import { codeFonts, installedFonts, uiFonts, userFonts } from '../fonts';
import {
  SETTINGS_SECTIONS,
  readSettingsSection,
  saveSettingsSection,
  type SettingsSection as Section,
} from '../vscode';

const T = ui.settings;
/** Ширина вкладки, с которой разделы — колонкой слева (уже — полосой вкладок над страницей). */
const NAV_PX = 600;
/** Разделы — отдельные страницы (не якоря одной ленты); открытый раздел помнит состояние webview. */
const SECTIONS = SETTINGS_SECTIONS;

/** Черновик поля: пока человек печатает, показываем его; пришло новое значение из хоста — берём его. */
function useDraft<V>(value: V): [V, (v: V) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [JSON.stringify(value)]);
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
}: {
  k: SettingKey;
  value: string;
  options: readonly (readonly [string, string])[];
}) {
  // отказ записи: перерисовать, чтобы <select> вернулся к значению из настроек
  void errors.value[k];
  return (
    <span class="dd">
      <select
        aria-label={k}
        value={value}
        onChange={(e) => commit(k, (e.currentTarget as HTMLSelectElement).value)}
      >
        {options.map(([v, label]) => (
          <option key={v} value={v}>
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
      <InfoRow name={I.agentTools.name} desc={I.agentTools.desc} keyText="agentura.jira.agentTools">
        <div class="cbs" aria-disabled="true">
          {(['comment', 'transition', 'worklog'] as const).map((t) => (
            <label key={t} class="off">
              <input type="checkbox" disabled checked={false} aria-label={I.agentTools[t]} />
              {I.agentTools[t]}
              {t !== 'comment' && <em> {I.agentTools.ask}</em>}
            </label>
          ))}
          <em class="soon">{I.agentTools.soon}</em>
        </div>
      </InfoRow>
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

type EngineId = 'claude' | 'codex' | 'antigravity';
const ENGINE_KEY = {
  claude: 'claudeExecutable',
  codex: 'codexExecutable',
  antigravity: 'antigravityExecutable',
} as const;

function EngineRow({ value, engine = 'claude' }: { value: string; engine?: EngineId }) {
  const [draft, setDraft] = useDraft(value);
  const k = ENGINE_KEY[engine];
  const text = engine === 'codex' ? T.exeCodex : engine === 'antigravity' ? T.exeAgy : T.exe;
  const c = (engine === 'codex' ? codexCheck : engine === 'antigravity' ? agyCheck : engineCheck)
    .value;
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
    ...EFFORT_LEVELS.map((e): [string, string] => [e, e]),
  ];

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
      <h2>{T.sections[id]}</h2>
      {children}
    </section>
  );

  return (
    <div class="webview settings">
      <header class="hud" aria-label={T.aria}>
        <span class="sess" style="display:block;padding-left:8px">
          Agentura · <b>{T.title.toLowerCase()}</b>
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
              <Row name={T.mode.name} isNew desc={T.mode.desc} k="defaultPermissionMode">
                <Select k="defaultPermissionMode" value={v.defaultPermissionMode} options={modes} />
              </Row>
              <Row
                name={T.bypass.name}
                desc={T.bypass.desc}
                k="allowBypassPermissions"
                machine
                on={v.allowBypassPermissions}
                below={
                  <div class="warn">
                    <b>{T.bypass.warnTitle}</b>
                    {T.bypass.warn}
                  </div>
                }
              >
                <Toggle k="allowBypassPermissions" value={v.allowBypassPermissions} danger />
              </Row>
              <Row name={T.model.name} desc={T.model.desc} k="defaultModel">
                <TextField
                  k="defaultModel"
                  value={v.defaultModel}
                  placeholder={T.model.placeholder}
                />
              </Row>
              <Row name={T.effort.name} isNew desc={T.effort.desc} k="defaultEffort">
                <Select k="defaultEffort" value={v.defaultEffort} options={efforts} />
              </Row>
              <Row
                name={T.remoteControl.name}
                isNew
                desc={T.remoteControl.desc}
                k="remoteControl"
                keyNote={T.remoteControl.keyNote}
              >
                <Toggle k="remoteControl" value={v.remoteControl} />
              </Row>
              <Row
                name={T.remoteControlNamePrefix.name}
                desc={T.remoteControlNamePrefix.desc}
                k="remoteControlNamePrefix"
              >
                <TextField
                  k="remoteControlNamePrefix"
                  value={v.remoteControlNamePrefix}
                  placeholder={T.remoteControlNamePrefix.placeholder}
                  wide
                />
              </Row>
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
            </>,
          )}
        </div>
      </div>
    </div>
  );
}
