// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { isAgentGraphView } from '../shared/agentsGraph';
import { agentGraphView, agentOpen, cardView, hudOfGraph } from './agentViews';
import { agentDetail } from './agentsView';
import { applyHud, initialHud } from './hudState';
import { AgentOpen } from './components/AgentViews';
import { ui } from './strings';

const host = document.createElement('div');
afterEach(() => render(null, host));
it('preserves declared parameters through HUD/graph and renders full literal prompt separately from native metadata', () => {
  const prompt = '<script>unsafe()</script>\n' + 'Exact launch line\n'.repeat(80) + 'END OF PROMPT';
  const start: AgentEvent = { type: 'agent.start', agentId: 'child', taskId: 'child', description: 'design',
    taskType: 'subagent', background: false, model: 'native-model', reasoningEffort: 'high',
    launchRecord: { source: 'parent', taskName: 'design', prompt, forkTurns: 'none',
      model: 'declared-model', reasoningEffort: 'low', recordedAt: 1000 } };
  let hud = applyHud(initialHud(), start, 1000);
  // Subsequent enrichment must preserve the parent record and actual execution metadata.
  hud = applyHud(hud, { ...start, launchRecord: undefined, model: 'actual-model' }, 2000);
  const snapshot = JSON.parse(JSON.stringify(agentGraphView(hud, { state: 'working' })));
  expect(isAgentGraphView(snapshot)).toBe(true);
  const node = hudOfGraph(snapshot).agents[0]!;
  expect(agentDetail(node, 2000).launchRecord?.prompt).toBe(prompt);
  expect(cardView(node, 2000).launchRecord?.prompt).toBe(prompt);
  const detail = agentOpen(node, 2000);
  render(h(AgentOpen, { d: detail, variant: 'open', onStop: () => {}, onTranscript: () => {} }), host);
  const disclosure = host.querySelector<HTMLDetailsElement>('details')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary')?.textContent).toBe(ui.agents.view.launchRecorded);
  disclosure.querySelector('summary')!.click();
  expect(disclosure.open).toBe(true);
  expect(disclosure.textContent).toContain(prompt);
  disclosure.querySelector('summary')!.click();
  expect(disclosure.open).toBe(false);
  expect(host.textContent).toContain(ui.agents.view.launchRecorded);
  expect(host.textContent).toContain(ui.agents.view.launchUnverified);
  expect(host.textContent).toContain('actual-model');
  expect(host.textContent).toContain('declared-model');
  expect(host.textContent).toContain(ui.agents.view.launchContextNone);
  expect(host.textContent).toContain(prompt);
  expect(host.textContent).not.toContain(ui.agents.view.promptUnavailable);
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector<HTMLElement>('.q')?.style.overflow).toBe('auto');
});
