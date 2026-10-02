// Боковая панель VS Code (аккаунт, лимиты, сессии) рядом с вкладкой чата — режим ширины «боковая панель + вкладка».
// Вставляется перед .webview по атрибуту data-sidebar на нём: live | wait | error | limit | new.
(function () {
  var wv = document.querySelector('.webview[data-sidebar]');
  if (!wv) return;
  var st = wv.getAttribute('data-sidebar');
  var gear = wv.getAttribute('data-gear') === 'on';
  var lim = st === 'limit'
    ? { h5: 100, h5t: 'сброс в 17:00 · через 2 ч 04 мин', wk: 36, full: true }
    : { h5: 62, h5t: 'сброс в 17:00 · через 2 ч 08 мин', wk: 34, full: false };
  var cur = {
    live:  { cls: 'cur live',  sub: '14 ходов · $1.84', when: 'сейчас' },
    wait:  { cls: 'cur wait',  sub: '15 ходов · $1.98 · ждёт ответа', when: 'сейчас' },
    error: { cls: 'cur err',   sub: '15 ходов · $1.91 · ошибка движка', when: '14:55' },
    limit: { cls: 'cur err',   sub: '17 ходов · $2.29 · лимит исчерпан', when: '14:56' },
    new:   { cls: '',          sub: '14 ходов · $1.84', when: '14:52' }
  }[st] || { cls: 'cur live', sub: '', when: '' };
  var top = st === 'new'
    ? '<button class="s cur live"><span class="dot"></span><span class="t">новая сессия<small>0 ходов · пусто</small></span><span class="ctx"></span><span class="when">сейчас</span></button>'
    : '';
  var html =
    '<aside class="sidebar-view" aria-label="Боковая панель VS Code">' +
      '<div class="activity" aria-hidden="true"><i class="a"></i><i></i><i></i><i></i><i class="on"></i></div>' +
      '<div class="sidebar" data-list="compact" data-ctx="on" data-time="on">' +
        '<div class="head"><span>Agentura</span><button class="gear' + (gear ? ' on' : '') + '" title="Настройки Agentura">⚙</button></div>' +
        '<section class="sec"><h3><span class="tri"></span>Аккаунт и лимиты<button class="refresh" title="Обновить лимиты · данные на 14:52">↻</button></h3>' +
          '<div class="kv"><span>Аккаунт</span><b>andrey@example.com</b><span>План</span><b>Max 5×</b><span>Вход</span><b>через CLI · ок</b><span>Агент</span><b>Claude · claude 2.1.284</b></div>' +
          '<div class="lim">' +
            '<div class="row"><span>Окно 5 часов</span><span class="n' + (lim.full ? ' full' : '') + '">' + lim.h5 + ' %</span><span class="bar"><i class="' + (lim.full ? 'full' : '') + '" style="width:' + lim.h5 + '%"></i></span><small>' + lim.h5t + '</small></div>' +
            '<div class="row"><span>Неделя</span><span class="n">' + lim.wk + ' %</span><span class="bar"><i style="width:' + lim.wk + '%"></i></span><small>сброс в четверг, 09:00</small></div>' +
          '</div></section>' +
        '<section class="sec"><h3><span class="tri"></span>Сессии<span class="r" style="color:var(--fg-mute)">queue-board</span><button class="view" title="Вид списка: компактно · переключить на «плотно»">≡</button></h3>' +
          '<button class="new"><span class="plus">＋</span>Новая сессия<span style="margin-left:auto;color:var(--fg-faint);font-size:11px">⌘⇧N</span></button></section>' +
        '<div class="tools"><input type="search" placeholder="Поиск по названию" disabled><button title="Фильтр">⚲</button></div>' +
        '<div class="list"><div class="day">Сегодня</div>' + top +
          '<button class="s ' + cur.cls + '"><span class="dot"></span><span class="t">мигание счётчика талонов<small>' + cur.sub + '</small></span><span class="ctx">131k ctx</span><span class="when">' + cur.when + '</span></button>' +
          '<button class="s wait"><span class="dot"></span><span class="t">плашка «нет связи» на табло<small>3 хода · $0.42 · ждёт ответа</small></span><span class="ctx">12k ctx</span><span class="when">13:05</span></button>' +
          '<button class="s"><span class="dot"></span><span class="t">почему падает lint в ws-client<small>2 хода · $0.11</small></span><span class="ctx">168k ctx</span><span class="when">11:48</span></button>' +
          '<div class="day">Вчера</div>' +
          '<button class="s"><span class="dot"></span><span class="t">миграция табло на новый ws-client<small>31 ход · $6.20</small></span><span class="ctx">27k ctx</span><span class="when">18:02</span></button>' +
          '<button class="s"><span class="dot"></span><span class="t">тесты очереди талонов<small>9 ходов · $1.05</small></span><span class="ctx">96k ctx</span><span class="when">11:30</span></button>' +
          '<div class="day">23 сентября</div>' +
          '<button class="s"><span class="dot"></span><span class="t">разбор падения board в проде<small>18 ходов · $3.70</small></span><span class="ctx">35k ctx</span><span class="when">вт</span></button>' +
        '</div>' +
      '</div>' +
    '</aside>';
  wv.insertAdjacentHTML('beforebegin', html);
})();
