import { signal } from '@preact/signals';
import { useId } from 'preact/hooks';
import type { SidebarLimitsMode } from '../../settings';
import {
  engineName,
  pickEngine,
  worstWindow,
  type EngineId,
  type EngineView,
} from '../engineLimitsView';
import { ui } from '../strings';
import { send } from '../vscode';
import { BrandIcon } from './BrandIcon';

/**
 * Лимиты нескольких движков (roadmap 42, этап 2):
 * - tabs: адаптивные вкладки с `interpolate-size: allow-keywords`, скрытием подписи на <345px, pip-точками и навигацией стрелками
 * - radar: сетка микро-плиток всех движков + детали выбранного ниже
 * - list: плотный вертикальный аккордеон с мини-шкалой в строке
 * - .diag-box: читаемый блок для error и signedOut с кнопками «Сменить аккаунт»/«Войти» и «Скрыть вкладку»
 */

interface Manual {
  engine: EngineId;
  base: EngineId | undefined;
}

interface ListState {
  base: EngineId | undefined;
  open: Set<EngineId>;
}

const picked = signal<Manual | undefined>(undefined);
const listState = signal<ListState | undefined>(undefined);

function getListOpenSet(engines: EngineView[], current: EngineId | undefined): Set<EngineId> {
  const cur = listState.value;
  if (cur && cur.base === current) {
    return cur.open;
  }
  const def = pickEngine(engines, current, undefined);
  return new Set<EngineId>(def ? [def] : []);
}

export function engineLimitsTitle(variant?: SidebarLimitsMode): string {
  void variant;
  return ui.sidebar.limitsTitle;
}

const whoText = (e: EngineView): string => [e.email, e.plan].filter(Boolean).join(' · ');

function isLoginEngine(engine: EngineId): engine is 'codex' | 'antigravity' | 'kimi' {
  return engine === 'codex' || engine === 'antigravity' || engine === 'kimi';
}

export function DiagBox({ e }: { e: EngineView }) {
  const isSignedOut = e.state === 'signedOut';
  const title = isSignedOut ? ui.sidebar.signedOutTitle : ui.sidebar.quotaUnavailable;
  const msg = isSignedOut
    ? ui.sidebar.signedOutMsg(engineName(e.engine))
    : (e.error || ui.sidebar.quotaUnavailable);
  const canLogin = isLoginEngine(e.engine);
  const loginEngine = isLoginEngine(e.engine) ? e.engine : undefined;
  const loginLabel = isSignedOut ? ui.sidebar.signIn : ui.sidebar.changeAccount;

  return (
    <div class="diag-box" data-engine={e.engine}>
      <div class="diag-hd">
        <span>{title}</span>
        {e.version && <span class="ver-txt">{e.version}</span>}
      </div>
      <p class="diag-msg">{msg}</p>
      <div class="diag-acts">
        {canLogin && loginEngine && (
          <button
            type="button"
            class="act-login"
            onClick={(ev) => {
              ev.stopPropagation();
              send({ type: 'engine.login', engine: loginEngine });
            }}
          >
            {loginLabel}
          </button>
        )}
        <button
          type="button"
          class="muted-act act-hide"
          onClick={(ev) => {
            ev.stopPropagation();
            send({ type: 'sidebar.hideEngine', engine: e.engine });
          }}
        >
          {ui.sidebar.hideTab}
        </button>
      </div>
    </div>
  );
}

export function EnginePanelBody({ e }: { e: EngineView }) {
  if (e.state === 'error' || e.state === 'signedOut') {
    return (
      <div class="panel-body">
        <DiagBox e={e} />
      </div>
    );
  }

  if (e.state === 'loading' && !e.windows.length && !whoText(e)) {
    return (
      <div class="panel-body">
        <span class="wait">{ui.sidebar.engineLoading}</span>
      </div>
    );
  }

  return (
    <div class="panel-body">
      {(e.email || e.plan || e.version) && (
        <div class="acc-line">
          {e.email && <span class="acc-id">{e.email}</span>}
          {e.plan && <span class="plan-chip">{e.plan}</span>}
          {e.version && <span class="ver-txt">{e.version}</span>}
        </div>
      )}
      <div class="gauges">
        {e.windows.map((w, i) => {
          const rowClass = [
            'g-row',
            w.percent >= 85 ? 'hot lim-full' : w.percent >= 70 ? 'warn lim-warn' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div class={rowClass} key={`${w.label}-${i}`} data-tip={w.note}>
              <span class="g-lbl">{w.label}</span>
              <span class="g-bar">
                <i style={{ width: `${w.percent}%` }} />
              </span>
              <span class="g-pct">{w.percent}%</span>
              <span class="g-rst">{w.reset ? ui.sidebar.resetShort(w.reset) : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TabsView({
  engines,
  current,
}: {
  engines: EngineView[];
  current: EngineId | undefined;
}) {
  const prefix = useId();
  const sel = pickEngine(engines, current, picked.value);

  const onKeyDown = (e: KeyboardEvent, idx: number) => {
    let nextIdx = -1;
    if (e.key === 'ArrowRight') {
      nextIdx = (idx + 1) % engines.length;
    } else if (e.key === 'ArrowLeft') {
      nextIdx = (idx - 1 + engines.length) % engines.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = engines.length - 1;
    }
    if (nextIdx >= 0) {
      e.preventDefault();
      const target = engines[nextIdx]!.engine;
      picked.value = { engine: target, base: current };
      const btn = (e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(
        `[data-eng="${target}"]`,
      );
      btn?.focus();
    }
  };

  return (
    <div class="limits-tabs">
      <div class="eng-tabs" role="tablist" aria-label={ui.sidebar.engineTabs}>
        {engines.map((x, idx) => {
          const isSelected = x.engine === sel;
          const w = worstWindow(x);
          const tabId = `${prefix}-tab-${x.engine}`;
          const panelId = `${prefix}-panel-${x.engine}`;
          const pipClass =
            x.state === 'error' || x.state === 'signedOut'
              ? 'st-pip err'
              : w && w.percent >= 85
                ? 'st-pip hot'
                : w && w.percent >= 70
                  ? 'st-pip warn'
                  : 'st-pip ok';

          const tip = w
            ? ui.sidebar.engineWorst(engineName(x.engine), w.percent)
            : x.state === 'error' && x.error
              ? ui.sidebar.engineError(x.error)
              : engineName(x.engine);

          return (
            <button
              type="button"
              role="tab"
              id={tabId}
              aria-controls={panelId}
              key={x.engine}
              data-eng={x.engine}
              data-engine={x.engine}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              title={tip}
              onClick={() => (picked.value = { engine: x.engine, base: current })}
              onKeyDown={(e) => onKeyDown(e, idx)}
            >
              <BrandIcon provider={x.engine} />
              <span class="tab-lbl">{engineName(x.engine)}</span>
              <i class={pipClass} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div class="eng-panels">
        {engines.map((x) => {
          const isSelected = x.engine === sel;
          const tabId = `${prefix}-tab-${x.engine}`;
          const panelId = `${prefix}-panel-${x.engine}`;
          return (
            <div
              key={x.engine}
              role="tabpanel"
              id={panelId}
              aria-labelledby={tabId}
              data-panel={x.engine}
              tabIndex={isSelected ? 0 : -1}
              hidden={!isSelected}
            >
              <EnginePanelBody e={x} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RadarView({
  engines,
  current,
}: {
  engines: EngineView[];
  current: EngineId | undefined;
}) {
  const sel = pickEngine(engines, current, picked.value);
  const activeEngine = engines.find((x) => x.engine === sel) ?? engines[0]!;

  return (
    <div class="limits-radar">
      <div
        class="radar-grid"
        role="tablist"
        aria-label={ui.sidebar.engineTabs}
        style={{ gridTemplateColumns: `repeat(${engines.length}, minmax(0, 1fr))` }}
      >
        {engines.map((x) => {
          const isSelected = x.engine === sel;
          const w = worstWindow(x);
          const isErr = x.state === 'error' || x.state === 'signedOut';
          const isHot = !isErr && w && w.percent >= 85;
          const isWarn = !isErr && w && w.percent >= 70 && w.percent < 85;

          const tileCls = [
            'r-tile',
            isSelected && 'sel',
            isErr && 'err',
            isHot && 'hot lim-full',
            isWarn && 'warn lim-warn',
          ]
            .filter(Boolean)
            .join(' ');

          const val = isErr ? '!' : w ? `${w.percent}%` : '—';
          const trackWidth = isErr ? 100 : w ? w.percent : 0;

          const tip = w
            ? ui.sidebar.engineWorst(engineName(x.engine), w.percent)
            : x.state === 'error' && x.error
              ? ui.sidebar.engineError(x.error)
              : engineName(x.engine);

          return (
            <button
              type="button"
              role="tab"
              key={x.engine}
              class={tileCls}
              data-radar={x.engine}
              data-engine={x.engine}
              aria-selected={isSelected}
              title={tip}
              onClick={() => (picked.value = { engine: x.engine, base: current })}
            >
              <BrandIcon provider={x.engine} />
              <span class="r-val">{val}</span>
              <span class="r-track">
                <i style={{ width: `${trackWidth}%` }} />
              </span>
            </button>
          );
        })}
      </div>
      <div class="radar-detail">
        <EnginePanelBody e={activeEngine} />
      </div>
    </div>
  );
}

function ListView({
  engines,
  current,
}: {
  engines: EngineView[];
  current: EngineId | undefined;
}) {
  const openSet = getListOpenSet(engines, current);

  const toggle = (id: EngineId) => {
    const next = new Set(openSet);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    listState.value = { base: current, open: next };
  };

  return (
    <div class="limits-list">
      <div class="acc-list">
        {engines.map((x) => {
          const isOpen = openSet.has(x.engine);
          const w = worstWindow(x);
          const isErr = x.state === 'error' || x.state === 'signedOut';
          const isHot = !isErr && w && w.percent >= 85;
          const isWarn = !isErr && w && w.percent >= 70 && w.percent < 85;

          const barColor = isHot ? 'var(--full)' : isWarn ? 'var(--warn)' : undefined;
          const pctColor = isHot ? 'var(--full)' : isWarn ? 'var(--warn)' : undefined;

          return (
            <div
              key={x.engine}
              class={`acc-item${isOpen ? ' open' : ''}`}
              data-acc={x.engine}
              data-engine={x.engine}
            >
              <button
                type="button"
                class="acc-row-btn"
                aria-expanded={isOpen}
                onClick={() => toggle(x.engine)}
              >
                <BrandIcon provider={x.engine} />
                <span class="nm">{engineName(x.engine)}</span>
                {isErr ? (
                  <span class="err-tag">
                    {x.state === 'signedOut' ? ui.sidebar.signedOut : ui.sidebar.quotaHidden}
                  </span>
                ) : w ? (
                  <>
                    <span class="g-bar">
                      <i style={{ width: `${w.percent}%`, ...(barColor ? { background: barColor } : {}) }} />
                    </span>
                    <span class="g-pct" style={pctColor ? { color: pctColor } : undefined}>
                      {w.percent}%
                    </span>
                  </>
                ) : (
                  <span class="err-tag">—</span>
                )}
              </button>
              {isOpen && (
                <div class="acc-sub">
                  <EnginePanelBody e={x} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EngineLimitsBody({
  variant,
  engines,
  current,
}: {
  variant: SidebarLimitsMode;
  engines: EngineView[];
  current: EngineId | undefined;
}) {
  if (engines.length === 0) return null;
  if (engines.length === 1) {
    return <EnginePanelBody e={engines[0]!} />;
  }
  switch (variant) {
    case 'tabs':
      return <TabsView engines={engines} current={current} />;
    case 'radar':
      return <RadarView engines={engines} current={current} />;
    case 'list':
      return <ListView engines={engines} current={current} />;
    default:
      return <TabsView engines={engines} current={current} />;
  }
}

export function resetEngineLimitsState(): void {
  picked.value = undefined;
  listState.value = undefined;
}
