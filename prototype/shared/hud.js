// Вкладки чат / ход / агенты в узкой колонке; выбор вкладки по #turn или #agents в адресе.
(function () {
  var side = document.querySelector('.pane.side');
  var chat = document.getElementById('pane-chat');
  var tabs = document.querySelectorAll('.tabs [data-tab]');
  if (!side || !chat || !tabs.length) return;
  var panes = { turn: document.getElementById('pane-turn'), agents: document.getElementById('pane-agents') };
  function wide() { return document.documentElement.getAttribute('data-width') !== '380'; }
  function select(k) {
    if (wide()) return; // в широком режиме вкладки живут в панели справа (второй блок ниже)
    tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x.getAttribute('data-tab') === k)); });
    if (k === 'chat') { chat.hidden = false; side.style.display = 'none'; }
    else { chat.hidden = true; side.style.display = 'block'; Object.keys(panes).forEach(function (p) { if (panes[p]) panes[p].hidden = p !== k; }); }
  }
  tabs.forEach(function (b) { b.addEventListener('click', function () { select(b.getAttribute('data-tab')); }); });
  var h = location.hash.replace('#', '');
  if (panes[h] && !wide()) select(h);
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-set-width]')) { chat.hidden = false; select('chat'); side.style.display = ''; Object.keys(panes).forEach(function (p) { if (panes[p]) panes[p].hidden = false; }); }
  });
})();

// Правая панель в широком режиме: вкладки ход | агенты, ресайз за левый край, скрыть/показать (вид A — кнопка в шапке, вид B — полоса).
// Состояние в прототипе не хранится: перезагрузка возвращает 300 px, развёрнута, «ход».
(function () {
  var html = document.documentElement;
  var body = document.querySelector('.body');
  var side = document.querySelector('.pane.side');
  var ptabs = document.querySelectorAll('.ptabs [data-ptab]');
  if (!body || !side || !ptabs.length) return;
  var DEF = 300, MIN = 220, RESERVE = 360;
  function wide() { return html.getAttribute('data-width') !== '380'; }
  function setActive(k) {
    side.setAttribute('data-active', k);
    ptabs.forEach(function (t) {
      var on = t.getAttribute('data-ptab') === k;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
  }
  function setOff(off) { if (off) body.setAttribute('data-side', 'off'); else body.removeAttribute('data-side'); }
  setActive(side.getAttribute('data-active') || 'turn');
  var h = location.hash.replace('#', '');
  if (wide() && (h === 'turn' || h === 'agents')) setActive(h);

  ptabs.forEach(function (t, i) {
    t.addEventListener('click', function () { setActive(t.getAttribute('data-ptab')); });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var n = ptabs[(i + (e.key === 'ArrowRight' ? 1 : ptabs.length - 1)) % ptabs.length];
      setActive(n.getAttribute('data-ptab')); n.focus(); e.preventDefault();
    });
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-panel],[data-rail-tab]');
    if (!t) return;
    if (t.hasAttribute('data-rail-tab')) { setActive(t.getAttribute('data-rail-tab')); setOff(false); return; }
    setOff(t.getAttribute('data-panel') === 'hide');
  });
  // ссылки «карта агентов» из ленты: в широком режиме открывают вкладку панели (и саму панель), в узком — как раньше
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-open-tab]');
    if (!a || !wide()) return;
    e.preventDefault(); e.stopPropagation();
    setActive(a.getAttribute('data-open-tab')); setOff(false);
  }, true);

  var grip = side.querySelector('.grip');
  if (!grip) return;
  function width(x) {
    var r = body.getBoundingClientRect();
    var max = Math.max(MIN, r.width - RESERVE);
    return Math.round(Math.min(max, Math.max(MIN, r.right - x)));
  }
  grip.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('drag'); html.classList.add('resizing');
    e.preventDefault();
  });
  grip.addEventListener('pointermove', function (e) {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    body.style.setProperty('--side-w', width(e.clientX) + 'px');
  });
  function stop(e) {
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    grip.classList.remove('drag'); html.classList.remove('resizing');
  }
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
  grip.addEventListener('dblclick', function () { body.style.setProperty('--side-w', DEF + 'px'); });
})();
