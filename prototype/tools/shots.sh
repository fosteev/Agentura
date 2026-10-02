#!/bin/sh
# Рендер экранов прототипа в PNG для галереи: <экран>-dark.png и <экран>-light.png, окно VS Code 1324x760
# (боковая панель 424 + вкладка чата 900). Запуск из корня репозитория:
#   sh prototype/tools/shots.sh <папка-вывода> [экран …]      (без экранов — все prototype/screens/*.html)
# Экран — имя без .html, например: sh prototype/tools/shots.sh /tmp/shots chat panel-rail
# С вкладкой — экран#вкладка (agents-done#agents → agents-done-agents-<тема>.png)
set -e
[ -n "$1" ] || { echo "usage: sh prototype/tools/shots.sh <out-dir> [screen ...]" >&2; exit 2; }
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$1"; shift
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp -R prototype "$TMP/proto"
# в копии: предпросмотр только ставит тему и ширину «vscode», рамка и отступы убраны
cat > "$TMP/proto/shared/preview.js" <<'JS'
(function () {
  var h = document.documentElement;
  var m = location.search.match(/theme=(dark|light)/);
  h.setAttribute('data-theme', m ? m[1] : 'dark');
  h.setAttribute('data-width', 'vscode');
  if (!h.getAttribute('data-collapse')) h.setAttribute('data-collapse', 'hidden');
})();
JS
echo '.preview-bar{display:none!important} .preview-stage{padding:0!important;min-height:0!important} .webview{border:0!important;border-radius:0!important;box-shadow:none!important} .sidebar-view{border:0!important;border-radius:0!important;box-shadow:none!important}' >> "$TMP/proto/shared/preview.css"
if [ $# -eq 0 ]; then set -- $(cd prototype/screens && ls *.html | sed 's/\.html$//'); fi
for n in "$@"; do
  f=${n%%#*}; h=""; o=$f
  case "$n" in *#*) h="#${n#*#}"; o="$f-${n#*#}";; esac
  for t in dark light; do
    "$CH" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files --hide-scrollbars \
      --force-device-scale-factor=2 --window-size=1324,760 --virtual-time-budget=2000 \
      --screenshot="$OUT/$o-$t.png" "file://$TMP/proto/screens/$f.html?theme=$t$h" >/dev/null 2>&1
    [ -s "$OUT/$o-$t.png" ] || echo "нет кадра: $o-$t" >&2
  done
  echo "$n: ok"
done
