/**
 * Vendored-парсер Agentmeter на его эталонах (`test/fixtures/claude`, копия `fixtures/claude`).
 * Проекция — перенос `projectResult` из `packages/core/test/claude/claude.test.ts` Agentmeter:
 * сравниваются только поля, перечисленные в `*.expected.json`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSessionFile, parseSubagents } from './agentmeter/sources/claude/parse.ts';
import type { ParseResult, Request, Session, ToolCall } from './agentmeter/sources/types.ts';

const fixturesDir = join(__dirname, '..', '..', 'test', 'fixtures', 'claude');

interface ExpectedResult {
  session: Record<string, unknown>;
  requests: Record<string, unknown>[];
  totals: Record<string, number>;
  unknownTypes: Record<string, number>;
  checks?: string;
}

describe('Agentmeter: парсер транскриптов Claude', () => {
  const scenarios = readdirSync(fixturesDir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => n.slice(0, -'.jsonl'.length))
    .sort();

  it('фикстуры на месте', () => expect(scenarios.length).toBeGreaterThanOrEqual(5));

  it.each(scenarios)('%s совпадает с expected.json', (scenario) => {
    const actual = parseSessionFile(join(fixturesDir, `${scenario}.jsonl`));
    const expected = readExpected(join(fixturesDir, `${scenario}.expected.json`));
    expect(projectResult(actual, expected)).toEqual(expected);
  });

  it('сабагенты через parseSubagents', () => {
    const results = parseSubagents(join(fixturesDir, 'sidechain.jsonl'));
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const name = basename(result.session.sourcePath, '.jsonl');
      const expected = readExpected(
        join(fixturesDir, 'sidechain.subagents', `${name}.expected.json`),
      );
      expected.session['id'] = name.replace(/^agent-/, '');
      const projected = projectResult(result, expected);
      projected.session['id'] = result.session.id;
      expect(projected).toEqual(expected);
    }
  });
});

function readExpected(path: string): ExpectedResult {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedResult;
}

function projectResult(actual: ParseResult, expected: ExpectedResult): ExpectedResult {
  return {
    ...(expected.checks === undefined ? {} : { checks: expected.checks }),
    session: projectSession(actual.session, expected.session),
    requests: actual.requests.map((request, index) =>
      projectRequest(request, expected.requests[index]),
    ),
    totals: sumTotals(actual.requests),
    unknownTypes: actual.diagnostics.unknownRecordTypes,
  };
}

function projectSession(
  session: Session,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    const value = session[key as keyof Session];
    projected[key] =
      key === 'startedAt' || key === 'endedAt' ? new Date(value as number).toISOString() : value;
  }
  return projected;
}

function projectRequest(
  request: Request,
  expected: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!expected) throw new Error(`unexpected request ${request.requestId}`);
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    if (key === 'ts') {
      projected['ts'] = new Date(request.ts).toISOString();
    } else if (key === 'tools') {
      const expectedTools = expected['tools'];
      if (!Array.isArray(expectedTools)) throw new Error('expected tools must be an array');
      projected['tools'] = request.tools.map((tool, index) =>
        projectTool(tool, expectedTools[index]),
      );
    } else {
      projected[key] = request[key as keyof Request];
    }
  }
  return projected;
}

function projectTool(tool: ToolCall, expected: unknown): Record<string, unknown> {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected))
    throw new Error(`unexpected tool ${tool.id}`);
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) projected[key] = tool[key as keyof ToolCall];
  return projected;
}

function sumTotals(requests: Request[]): Record<string, number> {
  return requests.reduce(
    (totals, r) => {
      totals.input += r.input;
      totals.output += r.output;
      totals.cacheWrite += r.cacheWrite;
      totals.cacheRead += r.cacheRead;
      return totals;
    },
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  );
}
