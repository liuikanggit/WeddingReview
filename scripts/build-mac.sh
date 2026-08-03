#!/bin/sh
# 本地打包 macOS 版本，产出可以直接发给别人的 .dmg。
#
# 默认打通用包（Intel + Apple Silicon 都能跑）。只给自己这台机器用的话，
# 加 --native 参数会快不少：只编当前架构。
#
# Windows 版本没法在 macOS 上打——Tauri 需要 MSVC 链接器和 Windows 侧的
# WebView2 依赖，官方明确不支持交叉编译。Windows 包走 GitHub Actions，
# 见 .github/workflows/release.yml。
set -e
cd "$(dirname "$0")/.."

TARGET_ARGS="--target universal-apple-darwin"
BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
LABEL="通用包（Intel + Apple Silicon）"

if [ "$1" = "--native" ]; then
  TARGET_ARGS=""
  BUNDLE_DIR="src-tauri/target/release/bundle"
  LABEL="当前架构"
fi

if [ -n "$TARGET_ARGS" ]; then
  # 通用包需要两个架构的标准库，缺了会拖到链接阶段才报错
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
fi

echo "正在打包 macOS $LABEL …"
pnpm tauri build $TARGET_ARGS

APP="$BUNDLE_DIR/macos/拾光笺.app"
DMG=$(find "$BUNDLE_DIR/dmg" -name "*.dmg" 2>/dev/null | head -1)

# 本机产物不该带 quarantine，但保险起见清一遍：
# 万一带着，装出来的应用会被 Gatekeeper 拦下
if [ -d "$APP" ]; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

  # 确认 ad-hoc 签名生效。没有签名的话，别人下载后会看到
  #「已损坏，应该移到废纸篓」——比"无法验证开发者"吓人得多，
  # 而且没有右键打开这条出路。
  if codesign -dv "$APP" 2>&1 | grep -q "Signature=adhoc"; then
    echo "✓ ad-hoc 签名正常"
  else
    echo "! 未检测到 ad-hoc 签名，补签一次"
    codesign --force --deep --sign - "$APP"
  fi
fi

# 和 dmg 放在一起的说明，转发时可以一并发过去
if [ -n "$DMG" ]; then
  xattr -dr com.apple.quarantine "$DMG" 2>/dev/null || true
  cat > "$(dirname "$DMG")/首次打开说明.txt" <<'TXT'
拾光笺 · 安装与首次打开

1. 双击 .dmg，把「拾光笺」拖进「应用程序」文件夹。
2. 第一次打开：在「应用程序」里找到「拾光笺」，
   按住 Control 点击图标 →「打开」→ 再点一次「打开」。
   （直接双击会被系统拦下，这一步只需做一次。）

如果提示「已损坏，无法打开」：
   多半是这个应用被聊天软件转发时压坏了。
   请让对方直接发 .dmg 文件本身，不要发「拾光笺.app」——
   .app 其实是个文件夹，经过压缩转发会丢掉内部的符号链接和执行权限。

   已经下载的也可以在「终端」里执行下面这行修复：
   xattr -dr com.apple.quarantine /Applications/拾光笺.app

这个应用没有购买 Apple 开发者签名，所以系统会多问一次，
不影响使用，也不联网。
TXT
fi

echo
echo "产物："
[ -n "$DMG" ] && echo "  $DMG"
[ -d "$APP" ] && echo "  $APP"
echo
echo "发给别人时请发 .dmg，不要发 .app —— .app 是文件夹，"
echo "经微信/QQ 等转发会丢掉符号链接与执行权限，对方打开就会报「已损坏」。"
echo "同目录下的「首次打开说明.txt」可以一并发过去。"
