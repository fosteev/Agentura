// Переключатели темы и ширины для предпросмотра в браузере.
(function () {
  var html = document.documentElement;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  function apply(attr, val) {
    html.setAttribute('data-' + attr, val);
    store.set('agentura-' + attr, val);
    document.querySelectorAll('[data-set-' + attr + ']').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-set-' + attr) === val));
    });
  }
  apply('theme', store.get('agentura-theme') || 'dark');
  apply('width', store.get('agentura-width') || document.documentElement.getAttribute('data-width') || '380');
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-set-theme],[data-set-width]');
    if (!t) return;
    if (t.hasAttribute('data-set-theme')) apply('theme', t.getAttribute('data-set-theme'));
    if (t.hasAttribute('data-set-width')) apply('width', t.getAttribute('data-set-width'));
  });
  // раскрытие/сворачивание блоков внутри прототипа
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle]');
    if (!t) return;
    var el = document.getElementById(t.getAttribute('data-toggle'));
    if (!el) return;
    var open = el.hasAttribute('hidden');
    if (open) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
    t.setAttribute('aria-expanded', String(open));
  });
})();
