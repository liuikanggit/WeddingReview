#!/bin/sh
# 从 SVG 源文件渲染出 1024×1024 的 PNG，再让 tauri 生成各平台全套图标。
# 用 Chrome 无头模式渲染，省掉装 librsvg/ImageMagick 这类依赖。
set -e
cd "$(dirname "$0")/.."

SRC="src-tauri/assets/icon-source.svg"
OUT="src-tauri/assets/icon-source.png"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME" ]; then
  echo "找不到 Chrome，无法渲染 SVG：$CHROME" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 包一层 HTML，去掉默认边距，保证截图正好是 1024×1024
cat > "$TMP/icon.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  img { display: block; width: 1024px; height: 1024px; }
</style>
<img src="icon.svg">
HTML
cp "$SRC" "$TMP/icon.svg"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 \
  --window-size=1024,1024 \
  --screenshot="$TMP/shot.png" \
  "file://$TMP/icon.html" >/dev/null 2>&1

cp "$TMP/shot.png" "$OUT"
echo "已渲染 $OUT"

pnpm tauri icon "$OUT"
echo "全套图标已写入 src-tauri/icons/"
