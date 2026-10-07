import { signal } from '@preact/signals';
import { Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import type { SidebarLimitsMode } from '../../settings';
import { limitLevel } from '../hudView';
import {
  ENGINE_MARK,
  ENGINE_MARK_CLASS,
  engineName,
  pickEngine,
  worstWindow,
  type EngineId,
  type EngineView,
  type EngineWindowView,
} from '../engineLimitsView';
import { ui } from '../strings';
import { send } from '../vscode';

/**
 * Лимиты нескольких движков (roadmap 18): пять вариантов по `prototype/screens/limits-multi.html`. Здесь только
 * разметка вариантов; секция, заголовок и ↻ — в `Sidebar.tsx`. Состояние выбора живёт в сигналах и привязано к
 * движку открытой вкладки: сменился `currentProvider` — ручной выбор сбрасывается.
 */

interface Manual {
  engine: EngineId;
  base: EngineId | undefined;
}
/** B: движок, выбранный руками. */
const picked = signal<Manual | undefined>(undefined);
/** D: движок, раскрытый кликом. */
const expanded = signal<Manual | undefined>(undefined);
/** E: всплывашка открыта. */
const popOpen = signal(false);

export function engineLimitsTitle(variant: SidebarLimitsMode): string {
  return variant === 'table'
    ? ui.sidebar.limitsTitle
    : variant === 'switch'
      ? ui.sidebar.account
      : ui.sidebar.accounts;
}

const lv = (percent: number | undefined): string =>
  percent === undefined ? '' : limitLevel(percent);

function Mark({ engine }: { engine: EngineId }) {
  return <i class={`mk ${ENGINE_MARK_CLASS[engine]}`}>{ENGINE_MARK[engine]}</i>;
}

/** `email · plan`; нет данных — пусто. */
const whoText = (e: EngineView): string => [e.email, e.plan].filter(Boolean).join(' · ');

/** Подсказка движка: аккаунт, план, версия; у `error` — текст ошибки. */
function engineTip(e: EngineView): string | undefined {
  const parts = [
    whoText(e),
    e.version,
    e.state === 'error' && e.error ? ui.sidebar.engineError(e.error) : '',
  ]
    .filter(Boolean)
    .join('\n');
  return parts || undefined;
}

function SignIn({ engine }: { engine: EngineId }) {
  if (engine === 'claude') return null;
  return (
    <button
      type="button"
      class="signin"
      data-tip={ui.sidebar.signInTip(engineName(engine))}
      onClick={(ev) => {
        ev.stopPropagation();
        send({ type: 'engine.login', engine });
      }}
    >
      {ui.sidebar.signIn}
    </button>
  );
}

/** Состояние движка без окон: «не вошли · войти» или «обновляется…» (приглушённо). */
function Status({ e }: { e: EngineView }) {
  if (e.state === 'signedOut') {
    return (
      <>
        <span>{ui.sidebar.signedOut}</span>
        <SignIn engine={e.engine} />
      </>
    );
  }
  if (e.state === 'loading' && !e.windows.length)
    return <span class="wait">{ui.sidebar.engineLoading}</span>;
  return <span>{whoText(e)}</span>;
}

function LimitLine({ w }: { w: EngineWindowView }) {
  return (
    <div class={`L ${lv(w.percent)}`} data-tip={w.note}>
      <span>{w.label}</span>
      <span class="bar">
        <i style={{ width: `${w.percent}%` }} />
      </span>
      <span class="n">{w.percent} %</span>
      <em class="rs">{w.reset ? ui.sidebar.resetShort(w.reset) : ''}</em>
    </div>
  );
}

function Lims({ e }: { e: EngineView }) {
  if (e.state === 'signedOut' || !e.windows.length) return null;
  return (
    <div class="lims">
      {e.windows.map((w) => (
        <LimitLine key={w.label} w={w} />
      ))}
    </div>
  );
}

const Dot = ({ e }: { e: EngineView }) => <i class={e.state === 'ok' ? 'okd' : 'okd off'} />;

/** A: блок на движок (и всплывашка варианта E — без метки «вкладка»). */
function Stack({ engines, current }: { engines: EngineView[]; current: EngineId | undefined }) {
  return (
    <>
      {engines.map((e) => (
        <div class="eng" key={e.engine} data-engine={e.engine}>
          <div class="eh" data-tip={engineTip(e)}>
            <Mark engine={e.engine} />
            <b>{engineName(e.engine)}</b>
            <Status e={e} />
            {current === e.engine && (
              <em class="now" data-tip={ui.sidebar.tabMarkTip}>
                {ui.sidebar.tabMark}
              </em>
            )}
            <Dot e={e} />
          </div>
          <Lims e={e} />
        </div>
      ))}
    </>
  );
}

/** B: сегменты движков; ниже — аккаунт и окна выбранного. */
function Switch({ engines, current }: { engines: EngineView[]; current: EngineId | undefined }) {
  const sel = pickEngine(engines, current, picked.value);
  const e = engines.find((x) => x.engine === sel)!;
  return (
    <>
      <div class="seg" role="tablist" aria-label={ui.sidebar.engineTabs}>
        {engines.map((x) => {
          const w = worstWindow(x);
          return (
            <button
              type="button"
              role="tab"
              key={x.engine}
              aria-selected={x.engine === sel}
              class={lv(w?.percent)}
              data-engine={x.engine}
              data-tip={
                w ? ui.sidebar.engineWorst(engineName(x.engine), w.percent) : engineName(x.engine)
              }
              onClick={() => (picked.value = { engine: x.engine, base: current })}
            >
              <Mark engine={x.engine} />
              {engineName(x.engine)}
              <i class="lv" />
            </button>
          );
        })}
      </div>
      <div class="who" data-tip={engineTip(e)}>
        {e.state === 'ok' || e.state === 'error' ? (
          <>
            <b>{e.email ?? ui.sidebar.unknown}</b>
            {e.plan && <span>· {e.plan}</span>}
            {e.version && <span>· {e.version}</span>}
          </>
        ) : (
          <Status e={e} />
        )}
        <Dot e={e} />
      </div>
      <Lims e={e} />
    </>
  );
}

/** C: строка на движок, до трёх ячеек окон. */
function Table({ engines }: { engines: EngineView[] }) {
  return (
    <div class="grid">
      {engines.map((e) => (
        <Fragment key={e.engine}>
          <span class="nm" data-tip={engineTip(e)}>
            <Mark engine={e.engine} />
            {ui.sidebar.tableShort[e.engine] ?? engineName(e.engine)}
          </span>
          {e.state === 'signedOut' ? (
            <span class="off">
              <Status e={e} />
            </span>
          ) : (
            [0, 1, 2].map((i) => {
              const w = e.windows[i];
              return w ? (
                <span class={`c ${lv(w.percent)}`} key={`${e.engine}-${i}`} data-tip={w.note}>
                  <em>{w.short}</em>
                  <span class="n">{w.percent}%</span>
                  <span class="bar">
                    <i style={{ width: `${w.percent}%` }} />
                  </span>
                </span>
              ) : (
                <span class="c none" key={`${e.engine}-${i}`}>
                  {ui.sidebar.unknown}
                </span>
              );
            })
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** D: текущий раскрыт, остальные — строкой с худшим окном. */
function Active({ engines, current }: { engines: EngineView[]; current: EngineId | undefined }) {
  const sel = pickEngine(engines, current, expanded.value);
  const act = engines.find((x) => x.engine === sel)!;
  const open = (id: EngineId) => (expanded.value = { engine: id, base: current });
  return (
    <>
      <div class="exp" data-engine={act.engine}>
        <div class="one hd" data-tip={engineTip(act)}>
          <i class="tw open" />
          <Mark engine={act.engine} />
          <b>{engineName(act.engine)}</b>
          <span class="acc">
            <Status e={act} />
            <Dot e={act} />
          </span>
        </div>
        <Lims e={act} />
      </div>
      {engines
        .filter((x) => x !== act)
        .map((e) => {
          const w = worstWindow(e);
          return (
            <div
              class={`one ${lv(w?.percent)}`.trim()}
              key={e.engine}
              role="button"
              tabIndex={0}
              aria-expanded="false"
              data-engine={e.engine}
              data-tip={[engineTip(e), w?.note].filter(Boolean).join('\n') || undefined}
              onClick={() => open(e.engine)}
              onKeyDown={(ev) => {
                if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
                  ev.preventDefault();
                  open(e.engine);
                }
              }}
            >
              <i class="tw" />
              <Mark engine={e.engine} />
              <b>{engineName(e.engine)}</b>
              {e.state === 'signedOut' ? (
                <span class="wl st">
                  <Status e={e} />
                </span>
              ) : w ? (
                <>
                  <span class="bar">
                    <i style={{ width: `${w.percent}%` }} />
                  </span>
                  <span class="n">{w.percent} %</span>
                  <em class="rs">{w.reset ? ui.sidebar.resetShort(w.reset) : ''}</em>
                </>
              ) : (
                <span class="wl st">
                  <Status e={e} />
                </span>
              )}
            </div>
          );
        })}
      <div class="gap" />
    </>
  );
}

/** Тело секции «Аккаунты и лимиты» для вариантов A–D (E — в заголовке панели). */
export function EngineLimitsBody({
  variant,
  engines,
  current,
}: {
  variant: Exclude<SidebarLimitsMode, 'header'>;
  engines: EngineView[];
  current: EngineId | undefined;
}) {
  switch (variant) {
    case 'switch':
      return <Switch engines={engines} current={current} />;
    case 'table':
      return <Table engines={engines} />;
    case 'active':
      return <Active engines={engines} current={current} />;
    default:
      return <Stack engines={engines} current={current} />;
  }
}

export interface RefreshProps {
  pending: boolean;
  title: string;
  onClick: () => void;
}

/** E: мини-шкала худшего лимита на движок в заголовке панели; клик открывает всплывашку. */
export function EngineHeaderLimits({
  engines,
  refresh,
}: {
  engines: EngineView[];
  refresh: RefreshProps;
}) {
  return (
    <span class="hx">
      <button
        type="button"
        class="mm"
        aria-haspopup="true"
        aria-expanded={popOpen.value}
        onClick={() => (popOpen.value = !popOpen.value)}
      >
        {engines.map((e) => {
          const w = worstWindow(e);
          return (
            <span
              class={`m ${lv(w?.percent)}`.trim()}
              key={e.engine}
              data-engine={e.engine}
              data-tip={[engineName(e.engine), w?.note].filter(Boolean).join(' · ')}
            >
              <Mark engine={e.engine} />
              {w ? (
                <>
                  <i class="b">
                    <b style={{ width: `${w.percent}%` }} />
                  </i>
                  <span class="n">{w.percent}</span>
                </>
              ) : (
                <span class="n">{ui.sidebar.unknown}</span>
              )}
            </span>
          );
        })}
      </button>
      <button
        type="button"
        class={refresh.pending ? 'refresh busy' : 'refresh'}
        data-tip={refresh.title}
        aria-label={ui.sidebar.refreshTitle}
        aria-busy={refresh.pending}
        disabled={refresh.pending}
        onClick={refresh.onClick}
      >
        {ui.sidebar.refresh}
      </button>
    </span>
  );
}

/** E: всплывашка со стопкой движков; закрывается Esc, кликом мимо и повторным кликом по шкалам. */
export function EnginePopup({ engines }: { engines: EngineView[] }) {
  const open = popOpen.value;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') popOpen.value = false;
    };
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Element | null;
      if (!t?.closest('.pop, .hx .mm')) popOpen.value = false;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class="pop" role="dialog" aria-label={ui.sidebar.accounts}>
      <Stack engines={engines} current={undefined} />
    </div>
  );
}

/** Для тестов: сброс выбора между сценариями. */
export function resetEngineLimitsState(): void {
  picked.value = undefined;
  expanded.value = undefined;
  popOpen.value = false;
}
