/* Local, in-memory interactions only. No provider requests or config writes. */
(function () {
  var host = document.getElementById('mcp-workspace');
  if (!host) return;
  var servers = [
    { name: 'webstorm', source: 'Проект', status: 'fail', detail: 'Не удалось подключиться · ECONNREFUSED' },
    { name: 'google-calendar', source: 'claude.ai', status: 'auth', detail: 'Требуется вход в аккаунт Google.' },
    { name: 'sentry', source: 'claude.ai', status: 'auth', detail: 'Требуется авторизация в Sentry.' },
    { name: 'serena', source: 'Пользователь', tools: 21, calls: 2, detail: 'find_symbol · 1 вызов\nfind_referencing_symbols · 1 вызов' },
    { name: 'context7', source: 'claude.ai', tools: 2, calls: 1, detail: 'query-docs · 1 вызов' },
    { name: 'jira', source: 'Встроенный', tools: 8, calls: 1, detail: 'get_issue · 1 вызов' },
    { name: 'figma', source: 'claude.ai', tools: 46, calls: 0, detail: 'В этой сессии вызовов ещё нет.' },
    { name: 'marketplace', source: 'Пользователь', tools: 38, calls: 0, detail: 'В этой сессии вызовов ещё нет.' }
  ];
  servers.forEach(function (s) { s.enabled = !(location.hash === '#off' && ['figma', 'marketplace'].includes(s.name)); });
  var filter = 'all', query = '', expanded = 'webstorm';
  host.innerHTML = '<header class="mcp-head"><span class="eyebrow">queue-board / Claude</span><h2>MCP-серверы</h2><p id="mcp-summary"></p></header>' +
    '<label class="mcp-search"><input type="search" aria-label="Поиск серверов" placeholder="Найти сервер…"></label>' +
    '<div class="mcp-filters" aria-label="Фильтр серверов"><button data-filter="all" aria-pressed="true">Все <span>8</span></button><button data-filter="attention" aria-pressed="false">Требуют внимания <span id="mcp-attention"></span></button></div>' +
    '<div class="mcp-results"></div><div class="mcp-footer"><details><summary>Скиллы сессии · 2</summary><p>sccloud-jira-frontend-triage<br>plan</p></details><p>Переключатели действуют в проекте queue-board.</p></div><div class="mcp-notice" role="status">Прототип · изменения только на этой странице</div>';
  function notice(text) { host.querySelector('.mcp-notice').textContent = text; }
  function render() {
    var ready = servers.filter(function (s) { return s.enabled && !s.status; });
    var attention = servers.filter(function (s) { return s.enabled && s.status; });
    document.getElementById('mcp-summary').innerHTML = '<strong>' + ready.length + ' из 8 подключены</strong> · ' + ready.reduce(function (n, s) { return n + s.tools; }, 0) + ' инструментов';
    document.getElementById('mcp-attention').textContent = attention.length;
    document.querySelector('.rp .ptabs .warn').textContent = attention.length;
    var composerCount = document.querySelector('.mcpb b');
    if (composerCount) composerCount.textContent = ready.length + '/8';
    var visible = servers.filter(function (s) { return s.name.includes(query) && (filter === 'all' || (s.enabled && s.status)); });
    var html = '';
    ['attention', 'ready', 'off'].forEach(function (group) {
      var items = visible.filter(function (s) { return (s.enabled ? (s.status ? 'attention' : 'ready') : 'off') === group; });
      if (!items.length) return;
      html += '<div class="mcp-group-title">' + ({ attention: 'Требуют внимания', ready: 'Подключены', off: 'Выключены' })[group] + ' · ' + items.length + '</div>';
      items.forEach(function (s) {
        var open = expanded === s.name;
        var state = !s.enabled ? 'Выключен' : s.status === 'fail' ? 'Ошибка подключения' : s.status === 'auth' ? 'Нужен вход' : s.tools + ' инстр. · ' + s.calls + ' выз.';
        html += '<section class="mcp-server"><div class="mcp-server-top"><button class="mcp-server-open" data-open="' + s.name + '" aria-expanded="' + open + '" aria-controls="detail-' + s.name + '"><span class="mcp-dot ' + (s.enabled ? s.status || '' : 'off') + '"></span><span><b>' + s.name + '</b><small>' + state + ' · ' + s.source + '</small></span><span class="mcp-chevron">›</span></button><button class="mcp-switch" role="switch" aria-checked="' + s.enabled + '" aria-label="' + s.name + ' в проекте queue-board" data-switch="' + s.name + '"></button></div>';
        html += '<div id="detail-' + s.name + '" class="mcp-details"' + (open ? '' : ' hidden') + '><p>' + s.detail.replace(/\n/g, '<br>') + '</p>' + (s.enabled && s.status ? '<button class="mcp-action" data-action="' + s.name + '">' + (s.status === 'fail' ? 'Повторить подключение' : 'Войти в аккаунт ↗') + '</button>' : '') + '</div></section>';
      });
    });
    host.querySelector('.mcp-results').innerHTML = html || '<p class="mcp-empty">' + (query ? 'Серверы не найдены' : 'Все подключения в порядке') + '</p>';
  }
  host.addEventListener('input', function (e) { if (e.target.matches('input')) { query = e.target.value.trim().toLowerCase(); render(); } });
  host.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.filter) {
      filter = b.dataset.filter;
      host.querySelectorAll('[data-filter]').forEach(function (el) { el.setAttribute('aria-pressed', String(el === b)); });
      render();
    } else if (b.dataset.open) {
      expanded = expanded === b.dataset.open ? '' : b.dataset.open;
      render();
      host.querySelector('[data-open="' + b.dataset.open + '"]').focus();
    } else if (b.dataset.switch) {
      var s = servers.find(function (s) { return s.name === b.dataset.switch; });
      s.enabled = !s.enabled;
      notice(s.name + (s.enabled ? ' включён' : ' выключен') + ' · демонстрация настройки проекта');
      render();
      var next = host.querySelector('[data-switch="' + s.name + '"]');
      (next || host.querySelector('[aria-pressed="true"]')).focus();
    } else if (b.dataset.action) {
      notice('Демо: ' + (b.dataset.action === 'webstorm' ? 'сервер недоступен, проверьте запуск WebStorm.' : 'в рабочем интерфейсе откроется авторизация.'));
    }
  });
  render();
})();
