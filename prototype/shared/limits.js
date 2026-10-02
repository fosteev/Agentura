// Цвет лимитов (5 часов, неделя): до 70 % — оранжевый, больше 70 % — жёлтый, больше 85 % — красный.
// Класс уровня ставится на счётчик у поля ввода (.m с .cells) и на строку лимита в боковой панели.
(function () {
  function level(p) { return p > 85 ? 'lim-full' : p > 70 ? 'lim-warn' : 'lim-hot'; }
  function pct(el) { var m = el && el.textContent.match(/(\d+)\s*%/); return m ? +m[1] : null; }
  document.querySelectorAll('.meters .m').forEach(function (m) {
    if (!m.querySelector('.cells')) return;
    var b = [].filter.call(m.querySelectorAll('b'), function (x) { return pct(x) !== null; })[0];
    var p = pct(b); if (p === null) return;
    m.classList.add('lim', level(p)); b.classList.add('pct');
  });
  document.querySelectorAll('.sidebar .lim .row, .sidebar .head .hl .m').forEach(function (r) {
    var p = pct(r.querySelector('.n')); if (p === null) return;
    r.classList.add(level(p));
  });
})();
