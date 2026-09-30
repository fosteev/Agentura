// Вкладки чат / ход / агенты в узкой колонке; выбор вкладки по #turn или #agents в адресе.
(function () {
  var side = document.querySelector('.pane.side');
  var chat = document.getElementById('pane-chat');
  var tabs = document.querySelectorAll('.tabs [data-tab]');
  if (!side || !chat || !tabs.length) return;
  var panes = { turn: document.getElementById('pane-turn'), agents: document.getElementById('pane-agents') };
  function select(k) {
    tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x.getAttribute('data-tab') === k)); });
    if (k === 'chat') { chat.hidden = false; side.style.display = 'none'; }
    else { chat.hidden = true; side.style.display = 'block'; Object.keys(panes).forEach(function (p) { if (panes[p]) panes[p].hidden = p !== k; }); }
  }
  tabs.forEach(function (b) { b.addEventListener('click', function () { select(b.getAttribute('data-tab')); }); });
  var h = location.hash.replace('#', '');
  if (panes[h]) select(h);
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-set-width]')) { select('chat'); side.style.display = ''; Object.keys(panes).forEach(function (p) { if (panes[p]) panes[p].hidden = false; }); }
  });
})();
