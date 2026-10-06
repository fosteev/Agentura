import { describe, expect, it } from 'vitest';
import { parseAgyError, parseAgyLine, userInputLine } from './protocol';

describe('протокол agy', () => {
  it('строка пользователя — NDJSON с event=user', () => {
    expect(JSON.parse(userInputLine('привет\nмир'))).toEqual({
      event: 'user',
      message: { role: 'user', content: 'привет\nмир' },
    });
    expect(userInputLine('x').endsWith('\n')).toBe(true);
  });

  it('разбор stdout: известные события, мусор и неизвестные event — undefined', () => {
    expect(parseAgyLine('{"event":"init","conversation_id":"c","init":{"model":"m"}}')).toMatchObject({ event: 'init' });
    expect(parseAgyLine('{"event":"init","conversation_id":"c"}')).toMatchObject({ init: {} });
    expect(parseAgyLine('{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool"}}')).toMatchObject({
      event: 'step_update',
    });
    expect(parseAgyLine('{"event":"result","result":{"status":"SUCCESS"}}')).toMatchObject({ event: 'result' });
    expect(parseAgyLine('{"event":"future","x":1}')).toBeUndefined();
    expect(parseAgyLine('not json')).toBeUndefined();
    expect(parseAgyLine('{broken')).toBeUndefined();
    expect(parseAgyLine('')).toBeUndefined();
    expect(parseAgyLine('{"event":"init"}')).toBeUndefined();
  });

  it('AGY_ERROR: JSON с message/code, голая строка и обычный stderr', () => {
    expect(parseAgyError('AGY_ERROR: {"code":429,"message":"quota"}')).toEqual({ message: 'quota', code: '429' });
    expect(parseAgyError('AGY_ERROR: {"error":"boom","type":"API"}')).toEqual({ message: 'boom', code: 'API' });
    expect(parseAgyError('AGY_ERROR: plain text')).toEqual({ message: 'plain text' });
    expect(parseAgyError('AGY_ERROR: {"foo":1}')).toEqual({ message: '{"foo":1}' });
    expect(parseAgyError('error: interrupted')).toBeUndefined();
  });
});
