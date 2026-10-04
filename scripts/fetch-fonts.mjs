// Шрифты внутрь расширения: семейства из scripts/fonts.json скачиваются с Google Fonts в media/fonts/<slug>/
// (woff2, наборы latin, latin-ext, cyrillic; начертания 400–700) вместе с лицензией из github.com/google/fonts.
// Пишет media/fonts/fonts.css (@font-face с относительными url) и src/webview/bundledFonts.ts (список для выбора).
// Сеть нужна только здесь; результат коммитится. Запуск из корня: node scripts/fetch-fonts.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SUBSETS = new Set(['latin', 'latin-ext', 'cyrillic']);
const WEIGHTS = '400;500;600;700';
// woff2 Google отдаёт только современному браузеру
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const OUT = join('media', 'fonts');

const list = JSON.parse(readFileSync(join('scripts', 'fonts.json'), 'utf8'));
const slug = (family) => family.toLowerCase().replace(/\s+/g, '');

async function get(url, binary = false) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
}

async function license(family) {
  for (const dir of ['ofl', 'apache', 'ufl'])
    for (const file of ['OFL.txt', 'LICENSE.txt', 'UFL.txt']) {
      const r = await fetch(`https://raw.githubusercontent.com/google/fonts/main/${dir}/${slug(family)}/${file}`);
      if (r.ok) return { file, text: await r.text() };
    }
  throw new Error(`лицензия не найдена: ${family}`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const css = ['/* Сгенерировано scripts/fetch-fonts.mjs — не править руками. Лицензии — рядом с файлами шрифтов. */'];
let bytes = 0;

for (const family of [...list.ui, ...list.code]) {
  const s = slug(family);
  const dir = join(OUT, s);
  mkdirSync(dir);
  const sheet = await get(
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${WEIGHTS}&display=swap`,
  );
  // блоки вида: /* cyrillic */ @font-face { … src: url(…) format('woff2'); unicode-range: …; }
  const files = new Map();
  for (const [, subset, body] of sheet.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*{([^}]*)}/g)) {
    if (!SUBSETS.has(subset)) continue;
    const url = body.match(/url\(([^)]+)\)/)?.[1];
    const weight = body.match(/font-weight:\s*([^;]+);/)?.[1].trim();
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1].trim();
    if (!url || !weight || !range) continue;
    // у вариативных семейств один файл на все начертания — качаем один раз
    if (!files.has(url)) {
      const name = `${subset}-${files.size}.woff2`;
      const data = await get(url, true);
      writeFileSync(join(dir, name), data);
      bytes += data.length;
      files.set(url, name);
    }
    css.push(
      `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap; ` +
        `src: url("${s}/${files.get(url)}") format("woff2"); unicode-range: ${range}; }`,
    );
  }
  if (files.size === 0) throw new Error(`нет файлов: ${family}`);
  const lic = await license(family);
  writeFileSync(join(dir, lic.file), lic.text);
  console.log(`${family}: ${files.size} файл(ов)`);
}

writeFileSync(join(OUT, 'fonts.css'), css.join('\n') + '\n');
writeFileSync(
  join('src', 'webview', 'bundledFonts.ts'),
  `// Сгенерировано scripts/fetch-fonts.mjs из scripts/fonts.json — не править руками.\n` +
    `/** Шрифты, которые лежат в расширении (media/fonts): доступны всегда, проверка установки не нужна. */\n` +
    `export const BUNDLED_UI_FONTS: readonly string[] = ${JSON.stringify(list.ui)};\n` +
    `export const BUNDLED_CODE_FONTS: readonly string[] = ${JSON.stringify(list.code)};\n`,
);
console.log(`итого ${(bytes / 1024).toFixed(0)} KB`);
