// Вкладка «git» (screens/git-pane.html): собирает #pane-git по данным варианта.
// Хэш: #one | #ma | #mb | #mc, суффикс -tree — вид «дерево» (git-pane.html#one-tree).
(function () {
  var w = document.querySelector('.webview');
  var pane = document.getElementById('pane-git');
  if (!w || !pane) return;

  function svg(d, extra) { return '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"' + (extra || '') + '>' + d + '</svg>'; }
  var I = {
    branch: svg('<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3-7 3.8"/>', ' style="width:12px;height:12px"'),
    repo: svg('<path d="M3.5 2.5h8v11h-8a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M2.5 11.5h9"/><path d="M5.5 5h3"/>'),
    fetch: svg('<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>'),
    pull: svg('<path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7"/><path d="M3 13.5h10"/>'),
    push: svg('<path d="M8 13.5v-8M4.5 9L8 5.5 11.5 9"/><path d="M3 2.5h10"/>'),
    more: svg('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'),
    open: svg('<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>'),
    discard: svg('<path d="M4 6.5h6.5a3 3 0 0 1 0 6H7"/><path d="M6.5 3.5L3.5 6.5l3 3"/>'),
    plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
    minus: svg('<path d="M3.5 8h9"/>'),
    spark: svg('<path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z"/><path d="M12.5 11.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/>')
  };

  function f(path, st, add, del, agent) { return { path: path, st: st, add: add, del: del, agent: agent }; }

  // один репозиторий: монорепо queue, ветка с двумя неотправленными коммитами
  var ONE = {
    name: 'queue', branch: 'fix/board-blink', up: 2, down: 0,
    un: [f('board/src/__tests__/Counter.test.tsx', 'U', 31, 0, 1), f('board/src/Counter.tsx', 'M', 6, 2, 1), f('.env.local', 'M', 1, 1, 0)],
    st: [f('ws-client/src/backoff.ts', 'A', 40, 0, 1), f('ws-client/src/reconnect.ts', 'M', 27, 7, 1)],
    log: [['a3f91c2', 'Reconnect: exponential backoff in ws-client', '14:02', 1], ['7be04d1', 'Board: queue counter reads snapshot', '13:20', 1], ['e5c2a88', 'Merge branch ‘main’ into fix/board-blink', 'вчера', 0], ['19d07fe', 'Board: ticket list virtualized', 'вчера', 0]]
  };
  // несколько репозиториев в рабочей папке queue/
  var REPOS = [
    { name: 'board', branch: 'fix/board-blink', up: 1, down: 0,
      un: [f('.env.local', 'M', 1, 1, 0)],
      st: [f('src/__tests__/Counter.test.tsx', 'A', 31, 0, 1), f('src/Counter.tsx', 'M', 6, 2, 1)],
      log: [['7be04d1', 'Counter reads snapshot', '13:20', 1], ['19d07fe', 'Ticket list virtualized', 'вчера', 0]] },
    { name: 'ws-client', branch: 'fix/reconnect', pub: false,
      un: [f('README.md', 'M', 12, 0, 1), f('src/__tests__/reconnect.test.ts', 'M', 18, 4, 1)],
      st: [f('src/backoff.ts', 'A', 40, 0, 1), f('src/reconnect.ts', 'M', 27, 7, 1)],
      log: [['c81e0b4', 'Reconnect on close code 1006', 'пн', 0]] },
    { name: 'infra', branch: 'main', up: 0, down: 3, un: [], st: [], log: [] }
  ];

  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function split(p) { var i = p.lastIndexOf('/'); return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]; }
  function stats(x) { return '<span class="ch mono">' + (x.add ? '<span class="add">+' + x.add + '</span>' : '') + (x.del ? ' <span class="del">−' + x.del + '</span>' : '') + '</span>'; }
  function br(r) { return '<span class="br" title="Сменить ветку">' + I.branch + '<span>' + esc(r.branch) + '</span><span class="car">▾</span></span>'; }
  function sync(r, short) {
    if (r.pub === false) return '<span class="sync"><span class="unpub" title="Ветки нет в origin — push её опубликует">' + (short ? 'нет в origin' : 'не опубликована') + '</span></span>';
    return '<span class="sync" title="Против origin/' + esc(r.branch) + '"><span' + (r.down ? ' class="pend"' : '') + '>↓<b>' + (r.down || 0) + '</b></span><span' + (r.up ? ' class="pend"' : '') + '>↑<b>' + (r.up || 0) + '</b></span></span>';
  }
  function syncBtns(r) {
    return '<button class="ib" title="Fetch">' + I.fetch + '</button><button class="ib' + (r.down ? ' on' : '') + '" title="Pull">' + I.pull + '</button><button class="ib' + (r.up || r.pub === false ? ' on' : '') + '" title="' + (r.pub === false ? 'Опубликовать ветку' : 'Push') + '">' + I.push + '</button>';
  }

  function row(x, staged, hov, lv, tree) {
    var p = split(x.path);
    return '<div class="f s-' + x.st + (hov ? ' hov' : '') + (tree ? ' tr' : '') + '"' + (tree ? ' style="--lv:' + lv + '"' : '') + ' title="' + esc(x.path) + '">' +
      '<span class="nm"><b>' + esc(p[1]) + '</b>' + (!tree && p[0] ? '<span class="d">' + esc(p[0]) + '</span>' : '') + '</span>' +
      (x.agent ? '<i class="adot" title="Правил агент в этой сессии"></i>' : '<span></span>') +
      stats(x) +
      '<span class="acts"><button class="ib" title="Открыть файл">' + I.open + '</button>' + (staged ? '' : '<button class="ib" title="Отменить изменения">' + I.discard + '</button>') +
      '<button class="ib" title="' + (staged ? 'Убрать из индекса' : 'В индекс') + '">' + (staged ? I.minus : I.plus) + '</button></span>' +
      '<span class="st">' + x.st + '</span></div>';
  }
  // дерево: папки отдельными строками, файлы с отступом
  function rows(list, staged, mode, hovPath) {
    if (mode !== 'tree') return list.map(function (x) { return row(x, staged, x.path === hovPath); }).join('');
    var out = '', seen = {};
    list.slice().sort(function (a, b) { return a.path < b.path ? -1 : 1; }).forEach(function (x) {
      var parts = split(x.path)[0].split('/').filter(Boolean);
      for (var k = 0; k < parts.length; k++) {
        var key = parts.slice(0, k + 1).join('/');
        if (seen[key]) continue; seen[key] = 1;
        out += '<div class="dr" style="--lv:' + k + '"><span class="chev">▾</span>' + esc(parts[k]) + '</div>';
      }
      out += row(x, staged, x.path === hovPath, parts.length, true);
    });
    return out;
  }
  function sec(title, list, staged, mode, hovPath, empty) {
    var h = '<div class="sh"><span class="chev">▾</span>' + title + ' <span class="n">' + list.length + '</span>' +
      (list.length ? '<button class="all' + (staged ? '' : ' pri') + '">' + (staged ? '− все' : '+ все в индекс') + '</button>' : '') + '</div>';
    return h + (list.length ? rows(list, staged, mode, hovPath) : '<div class="empty">' + empty + '</div>');
  }
  function bar(n, agent, mode) {
    return '<div class="bar"><span><b>' + n + '</b> изменений</span><span class="flt" title="Показать только файлы, которые правил агент"><i></i>агент ' + agent + '</span>' +
      '<span class="seg"><button data-git-mode="path" aria-pressed="' + (mode !== 'tree') + '">путь</button><button data-git-mode="tree" aria-pressed="' + (mode === 'tree') + '">дерево</button></span></div>';
  }
  function commit(o) {
    return '<div class="cm">' + (o.targets || '') +
      '<div class="box' + (o.focus ? ' focus' : '') + '"><div class="sum"><span class="t' + (o.summary ? '' : ' ph') + '">' + esc(o.summary || 'Сообщение коммита') + '</span>' +
      (o.summary ? '<span class="n">' + (72 - o.summary.length) + '</span>' : '') +
      '<button class="ib gen" title="Сообщение пишет агент по индексу">' + I.spark + '</button></div>' +
      '<div class="desc' + (o.desc ? '' : ' ph') + '">' + (o.desc || 'Описание') + '</div></div>' +
      '<div class="opt"><label><span class="cb"></span>amend</label><label><span class="cb' + (o.push ? ' on' : '') + '">' + (o.push ? '✓' : '') + '</span>и push</label><span class="r">' + (o.note || '') + '</span></div>' +
      '<div class="go' + (o.off ? ' off' : '') + '"><button class="main">' + o.label + '</button><button class="more" title="Коммит и push · коммит в новую ветку · stash">▾</button></div></div>';
  }
  function history(log, title) {
    if (!log.length) return '';
    return '<h6>' + (title || 'последние коммиты') + '</h6><div class="hs">' + log.map(function (c) {
      return '<div class="c' + (c[3] ? ' up' : '') + '"><span class="dot"></span><span class="h">' + c[0] + '</span><span class="m">' + esc(c[1]) + '</span><span class="w">' + (c[3] ? '↑ ' : '') + c[2] + '</span></div>';
    }).join('') + '</div>';
  }
  function count(r) { return r.un.length + r.st.length; }
  function agents(list) { return list.filter(function (x) { return x.agent; }).length; }
  var SUMMARY = 'Fix board counter blink on reconnect';
  var DESC = 'Counter keeps the last value until a new snapshot arrives; backoff for reconnects.';

  function one(mode) {
    var r = ONE, all = r.un.concat(r.st);
    return '<div class="gh"><span class="rp">' + I.repo + '</span><b style="font-weight:600">' + r.name + '</b>' + br(r) + sync(r) + '<span style="display:inline-flex">' + syncBtns(r) + '</span></div>' +
      '<div class="scroll">' + bar(all.length, agents(all), mode) +
      sec('неиндексированные', r.un, false, mode, 'board/src/Counter.tsx') +
      sec('в индексе', r.st, true, mode) + history(r.log) + '</div>' +
      commit({ summary: SUMMARY, desc: DESC, focus: true, push: false, label: 'Коммит · ' + r.st.length + ' файла <small>→ ' + r.branch + '</small>' });
  }
  function ws(right) {
    var n = REPOS.reduce(function (s, r) { return s + count(r); }, 0);
    return '<div class="ws"><span class="rp">' + I.repo + '</span><b>queue/</b><span>' + REPOS.length + ' репозитория · ' + n + ' изменений</span><span class="r">' + (right || '') + '</span></div>';
  }
  var wsBtns = '<button class="ib" title="Fetch во всех">' + I.fetch + '</button><button class="ib" title="Ещё">' + I.more + '</button>';

  // А · стопка: каждый репозиторий — свой раздел со своими списками и своим полем коммита
  function ma(mode) {
    var h = ws(wsBtns) + '<div class="scroll">';
    REPOS.forEach(function (r, i) {
      var n = count(r), open = n > 0;
      h += '<div class="rh' + (n ? '' : ' dim') + '"><span class="chev">' + (open ? '▾' : '▸') + '</span><span class="nm">' + r.name + '</span>' + br(r) +
        (n ? '<span class="n">' + n + '</span>' : '<span class="clean">чисто</span>') + sync(r, true) + '<span class="acts">' + (i === 2 ? '<button class="ib on" title="Pull">' + I.pull + '</button>' : '<button class="ib" title="Ещё">' + I.more + '</button>') + '</span></div>';
      if (!open) return;
      h += sec('неиндексированные', r.un, false, mode, i === 1 ? 'README.md' : null, 'нет');
      h += sec('в индексе', r.st, true, mode, null, 'пусто — «+» у файла');
      h += i === 0
        ? '<div class="cml"><span class="in" style="color:var(--fg)">' + SUMMARY + '</span><button style="background:var(--btn);color:var(--btn-fg)">Коммит</button></div>'
        : '<div class="cml"><span class="in">Сообщение коммита · ws-client</span><button>Коммит</button></div>';
    });
    return h + '</div>';
  }
  // Б · выбор сверху: список репозиториев с веткой и счётчиком, ниже — один выбранный, как в режиме одного репо
  function mb(mode) {
    var sel = REPOS[1];
    var pick = '<div class="pick">' + REPOS.map(function (r) {
      var n = count(r);
      return '<div class="p' + (r === sel ? ' on' : '') + '"><span class="rd"></span><span class="nm">' + r.name + '</span>' + br(r) + sync(r) + '<span class="n' + (n ? '' : ' z') + '">' + (n || '—') + '</span></div>';
    }).join('') + '</div>';
    var all = sel.un.concat(sel.st);
    return ws(wsBtns) + pick + '<div class="scroll">' + bar(all.length, agents(all), mode) +
      sec('неиндексированные', sel.un, false, mode, 'README.md') + sec('в индексе', sel.st, true, mode) + history(sel.log) + '</div>' +
      commit({ summary: 'Reconnect with exponential backoff', desc: '', focus: true, note: 'ветка не в origin', label: 'Коммит · ' + sel.st.length + ' файла <small>→ ' + sel.branch + '</small>' });
  }
  // В · общий список: одни секции на всю папку, внутри — подзаголовки репозиториев; один коммит в несколько репо
  function mc(mode) {
    var un = [], st = [], h;
    function grp(key, staged, hov) {
      return REPOS.filter(function (r) { return r[key].length; }).map(function (r) {
        return '<div class="rg"><span class="nm">' + r.name + '</span><span class="br">' + I.branch + '<span>' + esc(r.branch) + '</span></span>' + '</div>' + rows(r[key], staged, mode, hov);
      }).join('');
    }
    REPOS.forEach(function (r) { un = un.concat(r.un); st = st.concat(r.st); });
    var all = un.concat(st);
    h = ws(wsBtns) + '<div class="scroll">' + bar(all.length, agents(all), mode) +
      '<div class="sh"><span class="chev">▾</span>неиндексированные <span class="n">' + un.length + '</span><button class="all pri">+ все в индекс</button></div>' + grp('un', false, 'README.md') +
      '<div class="sh"><span class="chev">▾</span>в индексе <span class="n">' + st.length + '</span><button class="all">− все</button></div>' + grp('st', true) +
      '<h6>чистые</h6><div class="rg"><span class="nm" style="color:var(--fg-mute)">infra</span><span class="br">' + I.branch + '<span>main</span></span>' + sync(REPOS[2]) + '<button class="ib on" title="Pull">' + I.pull + '</button></div></div>';
    var targets = '<div class="tg"><span>в</span>' + REPOS.filter(function (r) { return r.st.length; }).map(function (r) {
      return '<span class="to"><span class="cb on" style="width:10px;height:10px;border-radius:2px;background:var(--btn);display:inline-grid;place-items:center;color:var(--btn-fg);font-size:8px">✓</span>' + r.name + ' <span class="mono">' + r.st.length + '</span></span>';
    }).join('') + '</div>';
    return h + commit({ targets: targets, summary: SUMMARY, desc: 'Одно сообщение — отдельный коммит в каждом отмеченном репозитории.', focus: true, push: true, label: 'Коммит в 2 репозитория <small>· 4 файла</small>' });
  }

  var V = { one: one, ma: ma, mb: mb, mc: mc };
  var state = { v: 'one', mode: 'path' };
  function render() {
    w.setAttribute('data-git', state.v);
    pane.innerHTML = V[state.v](state.mode);
    var n = state.v === 'one' ? 5 : 7;
    document.querySelectorAll('#git-badge, [data-rail-tab="git"] .b, .hud [data-tab="git"] .b').forEach(function (b) { b.textContent = n; });
  }
  var m = location.hash.match(/^#(one|ma|mb|mc)(-tree)?\b/);
  if (m) { state.v = m[1]; if (m[2]) state.mode = 'tree'; }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-git-set],[data-git-mode]');
    if (!b) return;
    if (b.hasAttribute('data-git-set')) state.v = b.getAttribute('data-git-set');
    else state.mode = b.getAttribute('data-git-mode');
    render();
  });
  render();
})();
