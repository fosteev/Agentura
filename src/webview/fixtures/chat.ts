/** Статические данные экрана chat (сессия «мигание счётчика талонов», 30.09, 14:41–14:56). Этап 1: без живых данных. */

/** Фрагмент текста: строка, `code` или выделение `b`. */
export type Seg = string | { code: string } | { b: string };

export interface ToolRow {
  kind: 'tool';
  op: string;
  dim?: string;
  what: string;
  /** Правая колонка. */
  r: { text?: string; add?: string; del?: string; pass?: string; diff?: boolean };
  think?: boolean;
  run?: boolean;
  now?: boolean;
}

export type LogItem =
  | { kind: 'sys'; text: Seg[]; at: string }
  | { kind: 'user'; text: Seg[]; at: string }
  | ToolRow
  | { kind: 'text'; paragraphs: Seg[][]; cursor?: boolean }
  | { kind: 'sum'; parts: string[]; cost: string; time: string }
  | { kind: 'live'; label: string };

export const log: LogItem[] = [
  {
    kind: 'sys',
    text: ['13:58 · контекст сжат автоматически: ', { b: '186 300 → 41 200' }, ' токенов'],
    at: '6 ходов ранее',
  },
  {
    kind: 'user',
    text: [
      'Почини мигание счётчика талонов на табло при переподключении сокета. Табло — ',
      { code: 'apps/board' },
      ', сокет — ',
      { code: 'packages/ws-client' },
      '.',
    ],
    at: '14:41',
  },
  {
    kind: 'tool',
    op: 'think',
    what: 'табло сбрасывает состояние при новом соединении, а не при новых данных',
    r: { text: '12s' },
    think: true,
  },
  {
    kind: 'tool',
    op: 'read',
    dim: 'packages/ws-client/src/',
    what: 'reconnect.ts',
    r: { text: '0.4s' },
  },
  { kind: 'tool', op: 'grep', what: 'ticketCount', dim: 'в apps/board', r: { text: '3 · 0.2s' } },
  { kind: 'tool', op: 'read', dim: 'apps/board/src/', what: 'Counter.tsx', r: { text: '0.3s' } },
  {
    kind: 'tool',
    op: 'edit',
    dim: 'apps/board/src/',
    what: 'Counter.tsx',
    r: { add: '+6', del: '−2', diff: true },
  },
  {
    kind: 'tool',
    op: 'bash',
    what: 'pnpm test --filter board',
    r: { pass: '12 ✓', text: '9.8s' },
    run: true,
  },
  {
    kind: 'text',
    paragraphs: [
      [
        'Причина — ',
        { code: 'Counter' },
        ' подписан на событие ',
        { code: 'open' },
        ' сокета и при каждом переподключении сбрасывал ',
        { code: 'count' },
        ' в ноль, пока не придёт первый снимок. На табло это выглядело как мигание.',
      ],
      [
        'Убрал сброс из обработчика ',
        { code: 'open' },
        ': счётчик держит последнее значение до нового снимка. Тесты табло проходят.',
      ],
    ],
  },
  {
    kind: 'sum',
    parts: ['in 1 204', 'out 2 318', 'cache r128 400 w3 902'],
    cost: '$0.21',
    time: '48s',
  },
  {
    kind: 'user',
    text: ['Добавь тест на переподключение, чтобы это не вернулось.'],
    at: '14:51',
  },
  {
    kind: 'tool',
    op: 'edit',
    dim: 'apps/board/src/__tests__/',
    what: 'Counter.test.tsx',
    r: { add: '+31', diff: true },
  },
  {
    kind: 'tool',
    op: 'bash',
    what: 'pnpm test --filter board',
    r: { text: '3.2s' },
    run: true,
    now: true,
  },
  {
    kind: 'text',
    paragraphs: [
      [
        'Добавил тест: имитирую разрыв и повторный ',
        { code: 'open' },
        ' без снимка и проверяю, что счётчик остаётся ',
        { code: '42' },
        ', а не падает в ноль. Запускаю',
      ],
    ],
    cursor: true,
  },
  { kind: 'live', label: 'отвечает · 11s' },
];

export interface Hud {
  agent: string;
  project: string;
  title: string;
  ctxNow: string;
  ctxMax: string;
  /** Классы 20 блоков шкалы контекста; '' — пустой. */
  blocks: string[];
  cache: { time: string; hit: string };
  h5: { percent: number; reset: string; cells: number };
}

export const hud: Hud = {
  agent: 'claude',
  project: 'queue-board',
  title: 'мигание счётчика талонов',
  ctxNow: '131 250',
  ctxMax: '200 000',
  blocks: [...Array<string>(11).fill('on'), 'on t', 'on w', 'part', 't', '', '', '', '', ''],
  cache: { time: '04:12', hit: '91%' },
  h5: { percent: 62, reset: '17:00', cells: 6 },
};

export interface TimelineRow {
  at: string;
  ev: string;
  d: string;
  now?: boolean;
  mute?: boolean;
}
export interface Timeline {
  heading: string;
  /** Сегменты полосы: класс и вес. */
  strip: { cls?: string; flex: number }[];
  rows: TimelineRow[];
}

export const turns: Timeline[] = [
  {
    heading: 'ход · 14:51 · идёт 11s',
    strip: [
      { cls: 'ed', flex: 14 },
      { cls: 'rn', flex: 32 },
      { cls: 'tx', flex: 60 },
    ],
    rows: [
      { at: '0.0', ev: 'edit Counter.test.tsx', d: '1.4s' },
      { at: '1.6', ev: 'bash pnpm test --filter board', d: '3.2s…', now: true },
      { at: '—', ev: 'текст ответа', d: 'стримится', mute: true },
    ],
  },
  {
    heading: 'предыдущий · 14:41 · 48s',
    strip: [
      { cls: 'th', flex: 120 },
      { flex: 4 },
      { flex: 2 },
      { flex: 3 },
      { cls: 'ed', flex: 11 },
      { cls: 'rn', flex: 98 },
      { cls: 'tx', flex: 150 },
    ],
    rows: [
      { at: '0.0', ev: 'think', d: '12s', mute: true },
      { at: '12.1', ev: 'read reconnect.ts', d: '0.4s' },
      { at: '12.6', ev: 'grep ticketCount', d: '3 · 0.2s' },
      { at: '13.0', ev: 'read Counter.tsx', d: '0.3s' },
      { at: '21.4', ev: 'edit Counter.tsx', d: '+6 −2 · 1.1s' },
      { at: '22.7', ev: 'bash pnpm test', d: '12 ✓ · 9.8s' },
      { at: '33.0', ev: 'текст ответа', d: '15s', mute: true },
    ],
  },
];

export interface AgentRow {
  kind: 'main' | 'sub';
  busy?: boolean;
  mark: string;
  name: string;
  meta: string;
  tokens: string;
  stoppable?: boolean;
}

export const agents: {
  rows: AgentRow[];
  totals: { label: string; value: string }[];
} = {
  rows: [
    { kind: 'main', mark: '●', name: 'основной', meta: 'opus-5.5 · отвечает', tokens: '131k' },
    {
      kind: 'sub',
      mark: '○',
      name: 'Explore: где обрабатывается reconnect',
      meta: 'sonnet-5.5 · готово 14:43',
      tokens: '8.1k',
    },
    {
      kind: 'sub',
      busy: true,
      mark: '◐',
      name: 'pnpm test --filter board',
      meta: 'фоновая задача · 3.2s',
      tokens: '—',
      stoppable: true,
    },
  ],
  totals: [
    { label: 'за сессию', value: '$1.84' },
    { label: 'ходов', value: '14' },
    { label: 'время', value: '2h 10m' },
    { label: 'кэш-попадания', value: '91%' },
  ],
};

export const compose = {
  context: [
    { name: 'Counter.tsx', range: ' 12–40' },
    { name: 'reconnect.ts', range: '' },
  ],
  placeholder: 'задача, @файл, /команда',
  mode: 'manual',
  model: 'opus-5.5',
  effort: 'high',
};
