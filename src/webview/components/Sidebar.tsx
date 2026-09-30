import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { LimitWindowSummary } from '../../protocol';
import { account, project, sessions } from '../fixtures/sessions';
import { ui } from '../strings';
import { onHostMessage, send } from '../vscode';

const percents = signal<Partial<Record<LimitWindowSummary['kind'], number>>>({});
const usage = signal<{ pending: boolean; updatedAt?: number; error?: string }>({ pending: false });

function refreshUsage() {
  if (usage.value.pending) return;
  usage.value = { ...usage.value, pending: true };
  send({ type: 'limits.refresh' });
}

function refreshTitle(): string {
  const u = usage.value;
  if (u.pending) return ui.sidebar.refreshing;
  const parts: string[] = [ui.sidebar.refreshTitle];
  if (u.updatedAt) {
    parts.push(`${ui.sidebar.updatedAt} ${new Date(u.updatedAt).toLocaleTimeString('ru')}`);
  }
  if (u.error) parts.push(`${ui.sidebar.refreshFailed}: ${u.error}`);
  return parts.join(' · ');
}

export function Sidebar() {
  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'limits.update') return;
        percents.value = Object.fromEntries(m.windows.map((w) => [w.kind, w.percent]));
        usage.value = { pending: false, updatedAt: m.updatedAt || undefined, error: m.error };
      }),
    [],
  );

  const u = usage.value;
  return (
    <div class="sidebar" aria-label={ui.sidebar.aria}>
      <div class="head">{ui.sidebar.head}</div>
      <section class="sec">
        <h3>
          <span class="tri" />
          {ui.sidebar.account}
          <button class="r">{ui.sidebar.status}</button>
          <button
            class={u.pending ? 'refresh busy' : 'refresh'}
            title={refreshTitle()}
            aria-label={ui.sidebar.refreshTitle}
            aria-busy={u.pending}
            disabled={u.pending}
            onClick={refreshUsage}
          >
            {ui.sidebar.refresh}
          </button>
        </h3>
        <div class="kv">
          {account.rows.map(([k, v]) => (
            <>
              <span>{k}</span>
              <b>{v}</b>
            </>
          ))}
        </div>
        <div class="lim">
          {account.limits.map((fixture) => {
            const l = { ...fixture, percent: percents.value[fixture.kind] ?? fixture.percent };
            return (
              <div class="row">
                <span>{l.label}</span>
                <span class="n">{l.percent} %</span>
                <span class="bar">
                  <i style={{ width: `${l.percent}%` }} />
                </span>
                <small>{l.note}</small>
              </div>
            );
          })}
        </div>
      </section>
      <section class="sec">
        <h3>
          <span class="tri" />
          {ui.sidebar.sessions}
          <span class="r" style={{ color: 'var(--fg-mute)' }}>
            {project}
          </span>
        </h3>
        <button class="new">
          <span class="plus">＋</span>
          {ui.sidebar.newSession}
          <span style={{ marginLeft: 'auto', color: 'var(--fg-faint)', fontSize: '11px' }}>
            {ui.sidebar.newSessionKey}
          </span>
        </button>
      </section>
      <div class="tools">
        <input type="search" placeholder={ui.sidebar.search} disabled />
        <button title={ui.sidebar.filterTitle}>⚲</button>
      </div>
      <div class="list">
        {sessions.map((d) => (
          <>
            <div class="day">{d.day}</div>
            {d.rows.map((s) => (
              <button class={`s ${s.cls ?? ''}`.trim()}>
                <span class="dot" />
                <span class="t">
                  {s.title}
                  <small>{s.sub}</small>
                </span>
                <span class="when">{s.when}</span>
              </button>
            ))}
          </>
        ))}
      </div>
    </div>
  );
}
