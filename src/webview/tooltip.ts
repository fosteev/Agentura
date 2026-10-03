// Тултип элементов управления: один слой на страницу, делегирование по [data-tip].
// Задержка 500 мс, «тёплый» показ соседних (< 300 мс после скрытия), под элементом, переворот вверх
// у нижнего края, прижим к бокам вьюпорта. Вид — media/tooltip.css (как в prototype/shared/tooltip.js).

const DELAY = 500;
const WARM = 300;
const GAP = 6;
const EDGE = 4;

/** Ставит слой и слушатели; возвращает снятие (слушатели + удаление слоя). */
export function installTooltips(doc: Document = document): () => void {
  const root = doc.documentElement;
  const tip = doc.createElement('div');
  tip.className = 'tip';
  tip.id = 'agentura-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.appendChild(tip);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cur: Element | null = null;
  let hiddenAt = 0;

  const tipOf = (t: EventTarget | null): Element | null =>
    t instanceof Element ? t.closest('[data-tip]') : null;

  function render(el: Element): void {
    tip.textContent = '';
    const key = el.getAttribute('data-tip-key');
    (el.getAttribute('data-tip') ?? '').split('\n').forEach((line, i) => {
      const row = doc.createElement('div');
      row.className = 'tl';
      row.appendChild(doc.createTextNode(line));
      if (i === 0 && key) {
        const k = doc.createElement('kbd');
        k.textContent = key;
        row.appendChild(k);
      }
      tip.appendChild(row);
    });
  }

  function place(el: Element): void {
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const up = r.bottom + GAP + h > vh - EDGE && r.top - GAP - h >= EDGE;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), vw - w - EDGE);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(up ? r.top - GAP - h : r.bottom + GAP)}px`;
    tip.setAttribute('data-side', up ? 'top' : 'bottom');
    tip.style.setProperty('--ax', `${Math.min(Math.max(8, r.left + r.width / 2 - left), w - 8)}px`);
  }

  function show(el: Element): void {
    cur = el;
    // за время задержки кнопка могла исчезнуть (ход закончился, список перерисован)
    if (!el.isConnected || !el.getAttribute('data-tip')) {
      hide();
      return;
    }
    render(el);
    tip.hidden = false;
    place(el);
    tip.classList.add('on');
    el.setAttribute('aria-describedby', tip.id);
  }

  function hide(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!tip.hidden) {
      tip.hidden = true;
      tip.classList.remove('on');
      hiddenAt = Date.now();
    }
    cur?.removeAttribute('aria-describedby');
    cur = null;
  }

  function schedule(el: Element): void {
    if (el === cur) return;
    const warm = !tip.hidden || Date.now() - hiddenAt < WARM;
    hide();
    timer = setTimeout(() => show(el), warm ? 0 : DELAY);
  }

  const onOver = (e: Event): void => {
    const el = tipOf(e.target);
    if (el) schedule(el);
    else if (cur || timer) hide();
  };
  const onOut = (e: Event): void => {
    if (!(e as MouseEvent).relatedTarget) hide();
  };
  const onFocusIn = (e: Event): void => {
    const el = tipOf(e.target);
    if (el?.matches(':focus-visible')) schedule(el);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') hide();
  };

  doc.addEventListener('pointerover', onOver);
  doc.addEventListener('pointerout', onOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', hide);
  doc.addEventListener('pointerdown', hide, true);
  doc.addEventListener('scroll', hide, true);
  doc.addEventListener('keydown', onKey);

  return () => {
    hide();
    doc.removeEventListener('pointerover', onOver);
    doc.removeEventListener('pointerout', onOut);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('focusout', hide);
    doc.removeEventListener('pointerdown', hide, true);
    doc.removeEventListener('scroll', hide, true);
    doc.removeEventListener('keydown', onKey);
    tip.remove();
  };
}
