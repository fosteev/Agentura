/* Вариант Б «Новая сессия»: состояние только в памяти страницы, настройки расширения не меняются.
   Хэш: #session (Claude раскрыт) · #session-codex · #session-cursor · #session-bypass (разрешён и выбран «без разрешений»). */
(() => {
  const root = document.getElementById('session');
  if (!root) return;
  const ENG = {
    claude: { name: 'Claude', logo: 'claude.svg', cls: 'nb-claude' },
    codex: { name: 'Codex', logo: 'openai.svg', cls: 'nb-mono' },
    cursor: { name: 'Cursor', logo: 'cursor.svg', cls: '' },
    antigravity: { name: 'Antigravity', logo: 'antigravity.svg', cls: '' },
  };
  const MODES = [
    ['manual', 'спрашивать'], ['acceptEdits', 'принимать правки'], ['plan', 'сначала план'], ['bypassPermissions', 'без разрешений'],
  ];
  const EFFORT = [['', 'выбор Claude Code'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
  const CODEX_MODELS = [['', 'из конфигурации Codex'], ['gpt-6-astra', 'gpt-6-astra'], ['gpt-6.1-sol', 'gpt-6.1-sol']];
  const CODEX_EFFORT = [['', 'выбор Codex'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']];
  const APPROVAL = [['', 'из конфигурации Codex'], ['untrusted', 'недоверенные команды'], ['on-request', 'по запросу агента'], ['never', 'никогда']];
  const SANDBOX = [['', 'из конфигурации Codex'], ['read-only', 'только чтение'], ['workspace-write', 'запись в папку'], ['danger-full-access', 'полный доступ']];

  const hash = location.hash.slice(1).split('-').slice(1).join('-');
  const s = {
    def: 'claude', mode: 'manual', bypass: false, open: ENG[hash] ? hash : 'claude',
    claude: { model: '', effort: 'high', remote: false, prefix: '' },
    codex: { model: '', effort: '', approval: '', sandbox: '' },
    cursor: { model: '' },
  };
  if (hash === 'bypass') { s.bypass = true; s.mode = 'bypassPermissions'; }

  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const logo = (id) => `<img src="../shared/brands/${ENG[id].logo}" class="${ENG[id].cls}" alt="">`;
  const label = (list, v) => (list.find(([k]) => k === v) || list[0])[1];
  const opts = (list, v, skip) => list.filter(([k]) => !(skip && skip(k))).map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${t}</option>`).join('');
  const set = (nm, ds, key, ctl, extra = '') => `<div class="set"><span class="nm">${nm}</span><span class="ds">${ds}</span><span class="key">${key}</span><span class="ctl">${ctl}</span>${extra}</div>`;
  const sel = (eng, f, list, opt = {}) => `<select data-e="${eng}" data-f="${f}" aria-label="${opt.aria || f}"${opt.disabled ? ' disabled' : ''}>${opts(list, s[eng][f], opt.skip)}</select>`;
  const txt = (eng, f, ph, aria) => `<input type="text" data-e="${eng}" data-f="${f}" value="${esc(s[eng][f])}" placeholder="${ph}" aria-label="${aria}">`;
  const tg = (f, on, danger) => `<span class="tg${on ? ' on' : ''}${danger ? ' danger' : ''}" role="switch" tabindex="0" aria-checked="${on}" data-tg="${f}"></span>`;
  const modeName = () => label(MODES, s.mode);

  // короткая сводка движка: в строке списка и в полосе «так откроется»
  function chips(id) {
    const c = [];
    if (id === 'claude') {
      c.push([s.claude.model || 'модель Claude Code', !s.claude.model], [s.claude.effort || 'effort движка', !s.claude.effort], [modeName(), false, s.mode === 'bypassPermissions']);
      if (s.claude.remote) c.push(['rc', false]);
    } else if (id === 'codex') {
      c.push([s.codex.model || 'модель из конфига', !s.codex.model], [s.codex.effort || 'effort из конфига', !s.codex.effort]);
      c.push([s.codex.sandbox ? label(SANDBOX, s.codex.sandbox) : 'доступ из конфига', !s.codex.sandbox, s.codex.sandbox === 'danger-full-access']);
    } else if (id === 'cursor') {
      c.push([s.cursor.model || 'Auto', !s.cursor.model], [modeName(), false, s.mode === 'bypassPermissions']);
    } else {
      c.push(['модель — в чате', true], [modeName(), false, s.mode === 'bypassPermissions']);
    }
    return c;
  }
  const chipHtml = (id) => chips(id).map(([t, dim, danger]) => `<span class="nb-chip${dim ? ' dim' : ''}${danger ? ' danger' : ''}">${esc(t)}</span>`).join('');
  const sumHtml = (id) => chips(id).map(([t, dim]) => (dim ? esc(t) : `<b>${esc(t)}</b>`)).join(' · ');

  function hero() {
    return `<div class="nb-hero">
      <div class="cap"><b>Так откроется новый чат</b><span>кнопка «＋» и пустая вкладка</span></div>
      <div class="nb-eng" role="radiogroup" aria-label="Движок нового чата">${Object.keys(ENG).map((id) =>
        `<button type="button" role="radio" aria-checked="${s.def === id}" data-def="${id}">${logo(id)}${ENG[id].name}</button>`).join('')}</div>
      <div class="nb-bar"><span class="ph">Опиши задачу…</span>${logo(s.def)}${chipHtml(s.def)}</div>
      <div class="foot">Строка под полем ввода с этими значениями. В открытом чате всё меняется там же; начатые и восстановленные чаты свои параметры не теряют.</div>
    </div>`;
  }

  function common() {
    const who = ['claude', 'cursor', 'antigravity'].map((id) => logo(id)).join('');
    const seg = MODES.filter(([k]) => k !== 'bypassPermissions' || s.bypass).map(([k, t]) =>
      `<button type="button" role="radio" aria-checked="${s.mode === k}" data-mode="${k}"${k === 'bypassPermissions' ? ' class="danger"' : ''}>${t}</button>`).join('');
    const warn = s.bypass ? `<div class="warn"><b>Без разрешений</b> агент правит файлы и запускает любые команды, не спрашивая, — включая удаление и сеть. Для изолированной папки или контейнера; на рабочем проекте — «принимать правки».</div>` : '';
    return `<h3 class="nb-h">Для всех движков</h3>
      ${set(`Режим нового чата <span class="nb-who" title="Claude, Cursor, Antigravity">${who}</span>`, 'С чего стартует чат. У Codex свои подтверждения и доступ — в его строке ниже. В чате меняется меню «режим» или ⇧⇥.', 'agentura.defaultPermissionMode', `<span class="nb-seg" role="radiogroup" aria-label="Режим нового чата">${seg}</span>`)}
      ${set('Разрешить режим «без разрешений»', 'Добавляет «без разрешений» в режимы выше и в чате, и «полный доступ» Codex. Сам режим не включает.', 'agentura.allowBypassPermissions · только эта машина', tg('bypass', s.bypass, true), warn)}`;
  }

  function body(id) {
    if (id === 'claude') {
      const pref = s.claude.remote ? set('Префикс имени', 'Как чат называется на claude.ai: «префикс · заголовок». Пусто — имя машины.', 'agentura.remoteControlNamePrefix', txt('claude', 'prefix', 'имя машины', 'Префикс имени')) : '';
      return set('Модель', 'Пусто — та, что стоит в Claude Code.', 'agentura.defaultModel', txt('claude', 'model', 'выбор Claude Code', 'Модель Claude'))
        + set('Effort', 'Сколько думать перед ответом.', 'agentura.defaultEffort', sel('claude', 'effort', EFFORT, { aria: 'Effort Claude' }))
        + set('Remote Control', 'Новый чат сразу виден на claude.ai/code и в приложении Claude. Ходы — на этой машине.', 'agentura.remoteControl', tg('remote', s.claude.remote))
        + pref;
    }
    if (id === 'codex') {
      const full = s.codex.sandbox === 'danger-full-access';
      const note = s.codex.approval === 'never' && !full
        ? '<div class="nb-note">«Никогда» не снимает песочницу: действие за её пределами просто получит отказ.</div>'
        : full ? '<div class="nb-note danger">Полный доступ: песочницы нет, сеть открыта. Подтверждения — по строке «Когда спрашивать».</div>' : '';
      return set('Модель', 'Из установленного Codex.', 'agentura.codex.defaultModel', sel('codex', 'model', CODEX_MODELS, { aria: 'Модель Codex' }) + '<button class="btn" type="button">↻</button>')
        + set('Effort', s.codex.model ? 'Уровни, которые поддерживает модель.' : 'Сначала модель — уровни зависят от неё.', 'agentura.codex.defaultEffort', sel('codex', 'effort', CODEX_EFFORT, { aria: 'Effort Codex', disabled: !s.codex.model }))
        + set('Когда спрашивать', 'Запросы подтверждения, не доступ.', 'agentura.codex.defaultApproval', sel('codex', 'approval', APPROVAL, { aria: 'Подтверждения Codex' }))
        + set('Доступ к файлам и командам', s.bypass ? 'Песочница Codex. Полный доступ разрешён выше.' : 'Песочница Codex, без сети. Полный доступ — после разрешения выше.', 'agentura.codex.defaultSandbox', sel('codex', 'sandbox', SANDBOX, { aria: 'Доступ Codex', skip: (k) => k === 'danger-full-access' && !s.bypass }))
        + note;
    }
    if (id === 'cursor') {
      return set('Модель', 'ACP-id из меню модели открытого чата, например <code>composer-2.5[fast=true]</code>. Пусто — Auto.', 'agentura.cursor.defaultModel', txt('cursor', 'model', 'Auto', 'Модель Cursor'))
        + '<div class="nb-note">Режим — общий, из блока выше. Effort и песочницы у Cursor нет.</div>';
    }
    return '';
  }

  function engines() {
    return `<h3 class="nb-h">Движки</h3><div class="nb-list">${Object.keys(ENG).map((id) => {
      const open = s.open === id && id !== 'antigravity';
      const flat = id === 'antigravity';
      return `<div class="nb-item${open ? ' open' : ''}" data-item="${id}">
        <button type="button" class="nb-row" data-open="${id}" aria-expanded="${open}"${flat ? ' aria-disabled="true" title="Своих настроек нового чата нет"' : ''}>
          ${logo(id)}<span>${ENG[id].name}</span><span class="sum">${sumHtml(id)}</span>
          <span class="def">${s.def === id ? 'по умолчанию' : ''}</span><span class="chev">${flat ? '' : '›'}</span></button>
        ${open ? `<div class="nb-body">${body(id)}</div>` : ''}</div>`;
    }).join('')}</div>`;
  }

  function render(focusSel) {
    root.innerHTML = `<h2>Новая сессия</h2><p class="nb-lead">Что получает новый чат. Сверху — итог, ниже — общее и по движкам.</p>${hero()}${common()}${engines()}`;
    if (focusSel) root.querySelector(focusSel)?.focus();
  }
  // текстовые поля — без перерисовки, чтобы не терять курсор; обновляем только сводки
  function refreshSummaries() {
    root.querySelector('.nb-bar').innerHTML = `<span class="ph">Опиши задачу…</span>${logo(s.def)}${chipHtml(s.def)}`;
    root.querySelectorAll('[data-item]').forEach((el) => { el.querySelector('.sum').innerHTML = sumHtml(el.dataset.item); });
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-def],[data-mode],[data-open],[data-tg]');
    if (!t) return;
    if (t.dataset.def) { s.def = t.dataset.def; render(`[data-def="${s.def}"]`); return; }
    if (t.dataset.mode) { s.mode = t.dataset.mode; render(`[data-mode="${s.mode}"]`); return; }
    if (t.dataset.open) {
      if (t.dataset.open === 'antigravity') return;
      s.open = s.open === t.dataset.open ? '' : t.dataset.open; render(`[data-open="${t.dataset.open}"]`); return;
    }
    if (t.dataset.tg === 'bypass') {
      s.bypass = !s.bypass;
      if (!s.bypass) { if (s.mode === 'bypassPermissions') s.mode = 'manual'; if (s.codex.sandbox === 'danger-full-access') s.codex.sandbox = ''; }
    } else if (t.dataset.tg === 'remote') s.claude.remote = !s.claude.remote;
    render(`[data-tg="${t.dataset.tg}"]`);
  });
  root.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && e.target.dataset.tg) { e.preventDefault(); e.target.click(); }
  });
  root.addEventListener('input', (e) => {
    const { e: eng, f } = e.target.dataset;
    if (eng && e.target.type === 'text') { s[eng][f] = e.target.value.trim(); refreshSummaries(); }
  });
  root.addEventListener('change', (e) => {
    const { e: eng, f } = e.target.dataset;
    if (!eng || e.target.tagName !== 'SELECT') return;
    s[eng][f] = e.target.value;
    if (eng === 'codex' && f === 'model') s.codex.effort = '';
    render(`[data-e="${eng}"][data-f="${f}"]`);
  });
  render();
})();
