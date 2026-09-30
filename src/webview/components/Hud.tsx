import type { Hud as HudData } from '../fixtures/chat';
import { ui } from '../strings';

function Cells({ cls, on }: { cls: string; on: number }) {
  return (
    <span class={`cells ${cls}`}>
      {Array.from({ length: 10 }, (_, i) => (
        <i class={i < on ? 'on' : ''} />
      ))}
    </span>
  );
}

export function Hud({ d, menu }: { d: HudData; menu?: preact.ComponentChildren }) {
  return (
    <header class="hud" aria-label={ui.hud.aria}>
      <div class="line1">
        <span class="agent" title={ui.hud.agentTitle}>
          {d.agent}
        </span>
        <span class="sess">
          {d.project} · <b>{d.title}</b>
        </span>
        <span class={menu ? 'acts pop' : 'acts'}>
          <button title={ui.hud.sessionsTitle}>{ui.hud.sessions}</button>
          <button title={ui.hud.newChatTitle}>{ui.hud.newChat}</button>
          {menu}
        </span>
      </div>
      <div class="ctx">
        <div class="big">
          <span>{d.ctxNow}</span>
          <small>/ {d.ctxMax}</small>
        </div>
        <div class="cap">
          <span>
            {ui.hud.context} {d.thresholds}
          </span>
          <button>{ui.hud.compact}</button>
        </div>
        <div class="blocks" aria-hidden="true">
          {d.blocks.map((c) => (
            <i class={c} />
          ))}
        </div>
      </div>
      <div class="meters">
        <span class="m">
          <span class="clock" />
          {ui.hud.cache} <b>{d.cache.time}</b> · <b>{d.cache.hit}</b>
        </span>
        <span class="m">
          <Cells cls="h5" on={d.h5.cells} />
          {ui.hud.fiveHour} <b>{d.h5.percent}%</b> →{d.h5.reset}
        </span>
        <span class="m">
          <Cells cls="wk" on={d.wk.cells} />
          {ui.hud.week} <b>{d.wk.percent}%</b> →{d.wk.reset}
        </span>
      </div>
    </header>
  );
}
