#!/bin/sh
# Проверка вёрстки прототипа headless-хромом: горизонтальная прокрутка и элементы за рамкой
# при ширинах 380 / 900 / «боковая панель + вкладка» в обеих темах. Запуск из корня репозитория:
#   sh prototype/tools/layout-check.sh
set -e
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d); cp -R prototype "$TMP/proto"; cp prototype/tools/layout-check.js "$TMP/proto/check.js"
for f in prototype/screens/*.html; do
  n=$(basename "$f")
  sed -i '' 's|</body>|<script src="../check.js"></script></body>|' "$TMP/proto/screens/$n"
  r=$("$CH" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files --window-size=1500,1000 \
      --virtual-time-budget=3000 --dump-dom "file://$TMP/proto/screens/$n" 2>/dev/null \
      | sed -n '/REPORT/,/END/p' | sed 's/<\/pre>//;s/&gt;/>/g;s/&lt;/</g' | grep -v -E '^(REPORT|END)$|layout-report|^OK' || true)
  echo "$n: ${r:-OK}"
done
rm -rf "$TMP"
