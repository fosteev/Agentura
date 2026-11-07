/* Локальное состояние демонстрации; не меняет настройки расширения. */
(() => {
  const root = document.getElementById('session');
  const fields = root.querySelector('#ns-fields');
  const names = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity' };
  const state = {
    claude: { model: '', effort: 'high', mode: 'manual', remote: false, prefix: '' },
    codex: { model: '', effort: '', approval: '', sandbox: '' },
    cursor: { model: '' }, antigravity: {},
  };
  let selected = 'claude', defaultProvider = 'claude', unlocked = false;
  const escape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const options = (items, value) => items.map(([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${label}</option>`).join('');
  const select = (key, items, disabled = false) => `<select id="ns-${key}" data-field="${key}" ${disabled ? 'disabled' : ''}>${options(items, state[selected][key])}</select>`;
  const input = (key, placeholder) => `<input id="ns-${key}" data-field="${key}" value="${escape(state[selected][key])}" placeholder="${placeholder}">`;
  const field = (key, title, note, control) => `<div class="ns-field"><label for="ns-${key}">${title}<small>${note}</small></label><div class="ns-control">${control}</div></div>`;
  const group = (title, content) => `<div class="ns-group"><h4>${title}</h4>${content}</div>`;
  function render() {
    root.querySelectorAll('[data-provider]').forEach(button => {
      const active = button.dataset.provider === selected;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      button.querySelector('.ns-default').hidden = button.dataset.provider !== defaultProvider;
    });
    root.querySelector('#ns-panel').setAttribute('aria-labelledby', `ns-tab-${selected}`);
    root.querySelector('#ns-provider-name').textContent = names[selected];
    root.querySelector('#ns-provider-note').textContent = selected === defaultProvider ? 'Открывает новые чаты по умолчанию' : 'Настройки для новых чатов с этим движком';
    root.querySelector('#ns-make-default').hidden = selected === defaultProvider;
    let keys = ['defaultProvider', 'allowBypassPermissions'];
    if (selected === 'claude') {
      fields.innerHTML = group('Модель и размышления',
        field('model', 'Модель', 'Оставь пустым, чтобы использовать выбор Claude Code.', input('model', 'Выбор Claude Code')) +
        field('effort', 'Глубина размышления', 'Больше глубина — больше времени на ответ.', select('effort', [['','Выбор Claude Code'], ['low','Низкая'], ['medium','Средняя'], ['high','Высокая'], ['xhigh','Очень высокая'], ['max','Максимальная']])));
      const modes = [['manual', 'Спрашивать разрешение', 'Запрашивать подтверждение действий, когда этого требуют правила Claude Code.'], ['acceptEdits', 'Принимать правки файлов', 'Правки без подтверждения. Команды — по правилам Claude Code.'], ['plan', 'Сначала составить план', 'Изучить задачу и предложить план перед выполнением.']];
      if (unlocked) modes.push(['bypassPermissions', 'Без подтверждений', 'Правки и команды без запросов разрешения.']);
      fields.innerHTML += group('Как выполнять задачу', `<div class="ns-permissions" role="radiogroup" aria-label="Режим Claude">${modes.map(([id,title,note]) => `<label class="ns-choice"><input type="radio" name="ns-mode" data-field="mode" value="${id}" ${state.claude.mode === id ? 'checked' : ''}><span><strong>${title}</strong><small>${note}</small></span></label>`).join('')}</div>`);
      fields.innerHTML += group('Продолжить с телефона', `<label class="ns-toggle-row"><span><strong>Remote Control</strong><small>Управлять чатом через claude.ai/code. Работа выполняется на этом компьютере.</small></span><input type="checkbox" role="switch" data-field="remote" ${state.claude.remote ? 'checked' : ''}></label><div id="ns-remote-details" ${state.claude.remote ? '' : 'hidden'}>${field('prefix', 'Префикс имени', 'Помогает отличать чаты с разных компьютеров.', input('prefix', 'Имя этого компьютера'))}</div>`);
      keys.push('defaultModel','defaultEffort','defaultPermissionMode','remoteControl','remoteControlNamePrefix');
    } else if (selected === 'codex') {
      fields.innerHTML = group('Модель и размышления',
        field('model', 'Модель', 'Из каталога установленного Codex.', select('model', [['','Выбор Codex'], ['demo','Модель из каталога · пример']])) +
        field('effort', 'Глубина размышления', state.codex.model ? 'Доступные уровни зависят от модели.' : 'Чтобы выбрать глубину, сначала выбери модель.', select('effort', [['','Выбор Codex'], ['low','Низкая'], ['medium','Средняя'], ['high','Высокая']], !state.codex.model)));
      const sandbox = [['','Выбор Codex'], ['readOnly','Только чтение'], ['workspaceWrite','Запись в рабочую папку']];
      if (unlocked) sandbox.push(['dangerFullAccess','Полный доступ']);
      fields.innerHTML += group('Разрешения',
        field('approval', 'Когда спрашивать', 'Управляет запросами подтверждения, а не доступом к файлам.', select('approval', [['','Выбор Codex'], ['untrusted','Для недоверенных команд'], ['on-request','По запросу агента'], ['never','Никогда']])) +
        field('sandbox', 'Что доступно агенту', 'Чтение и запись ограничены sandbox, сеть выключена. Полный доступ снимает эти ограничения.', select('sandbox', sandbox)) + '<p id="ns-permission-summary"></p>');
      updateSummary();
      keys.push('codex.defaultModel','codex.defaultEffort','codex.defaultApproval','codex.defaultSandbox');
    } else if (selected === 'cursor') {
      fields.innerHTML = group('Модель', field('model', 'Модель Cursor', 'Оставь пустым для автоматического выбора. Свой ID можно скопировать из меню модели открытого чата.', input('model', 'Auto · выбор Cursor')) + '<p>Например: composer-2.5[fast=true]. Начальный режим берётся из общей настройки режима Claude.</p>');
      keys.push('cursor.defaultModel', 'defaultPermissionMode');
    } else {
      fields.innerHTML = group('Настройки движка', `<p>В текущей реализации отдельные настройки модели для ${names[selected]} на этой странице ещё не представлены. Модель можно выбрать в чате.</p><p>Начальный режим берётся из общей настройки режима Claude.</p>`);
      keys.push('defaultPermissionMode');
    }
    root.querySelector('#ns-keys').innerHTML = keys.map(key => `<div>agentura.${key}</div>`).join('');
  }
  function updateSummary() {
    const el = root.querySelector('#ns-permission-summary');
    if (!el) return;
    el.textContent = state.codex.approval === 'never' && state.codex.sandbox !== 'dangerFullAccess'
      ? '«Никогда» не снимает ограничения доступа. Действие за пределами sandbox завершится отказом.'
      : state.codex.sandbox === 'dangerFullAccess'
        ? 'Полный доступ: ограничения sandbox сняты. Подтверждения определяются настройкой выше.'
        : '«Выбор Codex» использует соответствующее значение из его конфигурации.';
  }
  root.querySelectorAll('[data-provider]').forEach(button => {
    button.addEventListener('click', () => { selected = button.dataset.provider; render(); });
    button.addEventListener('keydown', event => {
      const tabs = [...root.querySelectorAll('[data-provider]')];
      const index = tabs.indexOf(button);
      const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (target < 0) return;
      event.preventDefault(); tabs[target].click(); tabs[target].focus();
    });
  });
  root.querySelector('#ns-make-default').addEventListener('click', () => { defaultProvider = selected; render(); root.querySelector(`[data-provider="${selected}"]`).focus(); announce(); });
  const announce = () => { root.querySelector('#ns-status').textContent = 'Изменено в макете · настройки расширения не затронуты'; };
  fields.addEventListener('input', event => {
    const el = event.target;
    if (el.dataset.field && el.tagName === 'INPUT' && el.type === 'text') state[selected][el.dataset.field] = el.value;
  });
  fields.addEventListener('change', event => {
    const el = event.target, key = el.dataset.field;
    if (!key) return;
    state[selected][key] = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'remote') root.querySelector('#ns-remote-details').hidden = !el.checked;
    if (selected === 'codex' && key === 'model') { state.codex.effort = ''; render(); root.querySelector('#ns-model').focus(); }
    updateSummary(); announce();
  });
  root.querySelector('#ns-unlock').addEventListener('change', event => {
    unlocked = event.target.checked;
    if (!unlocked) {
      if (state.claude.mode === 'bypassPermissions') state.claude.mode = 'manual';
      if (state.codex.sandbox === 'dangerFullAccess') state.codex.sandbox = '';
    }
    render(); announce();
  });
  render();
})();
