// Тултип элементов управления: делегирование по [data-tip], задержка 500 мс, «тёплый» показ соседних,
// под элементом с переворотом вверх у нижнего края и прижимом к бокам. В прототипе title → data-tip
// переводится на лету; хэш #tip-<имя> показывает тултип сразу — для снимков галереи.
(function () {
  var DELAY = 500, WARM = 300, GAP = 6, EDGE = 4;
  var PRESETS = {
    gear: '.head .gear', refresh: '.refresh', view: '.sec .view', send: '.send', phide: '.phide',
    ctx: '.cn', limit: '.meters .m[data-tip]', stop: '.stop',
  };
  var tip = document.createElement('div');
  tip.className = 'tip';
  tip.id = 'agentura-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  var timer = 0, cur = null, hiddenAt = 0;

  function adopt() {
    document.querySelectorAll('body [title]').forEach(function (el) {
      el.setAttribute('data-tip', el.getAttribute('title').replace(/ · (данные|сброс)/, '\n$1'));
      el.removeAttribute('title');
    });
    var send = document.querySelector('.send[data-tip]');
    if (send && !send.hasAttribute('data-tip-key')) {
      send.setAttribute('data-tip', 'Отправить');
      send.setAttribute('data-tip-key', 'Enter');
    }
  }

  function render(el) {
    tip.textContent = '';
    el.getAttribute('data-tip').split('\n').forEach(function (line, i) {
      var row = document.createElement('div');
      row.className = 'tl';
      row.appendChild(document.createTextNode(line));
      var key = el.getAttribute('data-tip-key');
      if (i === 0 && key) {
        var k = document.createElement('kbd');
        k.textContent = key;
        row.appendChild(k);
      }
      tip.appendChild(row);
    });
  }

  function place(el) {
    var r = el.getBoundingClientRect();
    var w = tip.offsetWidth, h = tip.offsetHeight;
    // в прототипе боковая панель и чат — на одной странице; в VS Code это отдельные webview, прижим — к своему
    var box = el.closest('.sidebar-view, .webview');
    var b = box ? box.getBoundingClientRect()
      : { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    var up = r.bottom + GAP + h > b.bottom - EDGE && r.top - GAP - h >= b.top + EDGE;
    var left = Math.min(Math.max(b.left + EDGE, r.left + r.width / 2 - w / 2), b.right - w - EDGE);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(up ? r.top - GAP - h : r.bottom + GAP) + 'px';
    tip.setAttribute('data-side', up ? 'top' : 'bottom');
    tip.style.setProperty('--ax', Math.min(Math.max(8, r.left + r.width / 2 - left), w - 8) + 'px');
  }

  function show(el) {
    cur = el;
    render(el);
    tip.hidden = false;
    place(el);
    tip.classList.add('on');
    el.setAttribute('aria-describedby', tip.id);
  }

  function hide() {
    clearTimeout(timer);
    timer = 0;
    if (!tip.hidden) {
      tip.hidden = true;
      tip.classList.remove('on');
      hiddenAt = Date.now();
    }
    if (cur) cur.removeAttribute('aria-describedby');
    cur = null;
  }

  function schedule(el) {
    if (el === cur) return;
    var warm = !tip.hidden || Date.now() - hiddenAt < WARM;
    hide();
    timer = setTimeout(function () { show(el); }, warm ? 0 : DELAY);
  }

  document.addEventListener('pointerover', function (e) {
    var el = e.target.closest('[data-tip]');
    if (el) schedule(el);
    else if (cur || timer) hide();
  });
  document.addEventListener('pointerout', function (e) {
    if (!e.relatedTarget) hide();
  });
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest('[data-tip]');
    if (el && el.matches(':focus-visible')) schedule(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  });

  adopt();
  new MutationObserver(adopt).observe(document.body, { subtree: true, childList: true, attributeFilter: ['title'] });
  var m = location.hash.match(/tip-(\w+)/);
  var target = m && document.querySelector(PRESETS[m[1]] || m[1]);
  if (target) show(target);
})();
