/** Статические данные экрана sessions (боковая панель). */
export interface SessionRow {
  cls?: 'cur live' | 'wait' | '';
  title: string;
  sub: string;
  when: string;
}
export interface SessionDay {
  day: string;
  rows: SessionRow[];
}

export const account = {
  rows: [
    ['Аккаунт', 'andrey@example.com'],
    ['План', 'Max 5×'],
    ['Вход', 'через CLI · ок'],
    ['Агент', 'Claude · claude 2.1.284'],
  ] as [string, string][],
  limits: [
    {
      kind: 'five-hour' as const,
      label: 'Окно 5 часов',
      percent: 62,
      note: 'сброс в 17:00 · через 2 ч 08 мин',
    },
    { kind: 'weekly' as const, label: 'Неделя', percent: 34, note: 'сброс в четверг, 09:00' },
  ],
};

export const project = 'queue-board';

export const sessions: SessionDay[] = [
  {
    day: 'Сегодня',
    rows: [
      {
        cls: 'cur live',
        title: 'мигание счётчика талонов',
        sub: '14 ходов · $1.84 · 131k',
        when: 'сейчас',
      },
      {
        cls: 'wait',
        title: 'плашка «нет связи» на табло',
        sub: '3 хода · $0.42 · ждёт ответа',
        when: '13:05',
      },
      { title: 'почему падает lint в ws-client', sub: '2 хода · $0.11', when: '11:48' },
    ],
  },
  {
    day: 'Вчера',
    rows: [
      { title: 'миграция табло на новый ws-client', sub: '31 ход · $6.20', when: '18:02' },
      { title: 'тесты очереди талонов', sub: '9 ходов · $1.05', when: '11:30' },
    ],
  },
  {
    day: '23 сентября',
    rows: [
      { title: 'разбор падения board в проде', sub: '18 ходов · $3.70', when: 'вт' },
      { title: 'обновить зависимости монорепо', sub: '5 ходов · $0.58', when: 'вт' },
    ],
  },
];
