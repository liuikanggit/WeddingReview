# 拾光笺

婚纱照修图批注工具（macOS）。导入相册文件夹，在照片上画标记、写说明、勾选修图要求，最后导出一份图文一体的 PDF 交给修图师。

## 用法

1. 打开应用，选择存放婚纱照的文件夹（下次启动会自动打开上次的相册）
2. 点开任意照片，用画笔 / 箭头 / 矩形圈出要改的地方，文字工具可以直接选「瑕疵」「重点」等快捷词
3. 右侧维护一份常用修图要求（如「磨皮」「瘦脸」），每张照片勾选适用项，再补一句本张备注
4. 回到相册页点「导出修图批注 PDF」，每张照片一页，标记和要求都在上面

批注数据保存在相册文件夹内的 `.weddingreview/` 里，跟着文件夹一起移动、拷贝都不会丢。

## 快捷键

工具快捷键沿用 Photoshop 的习惯：

| 按键 | 作用 |
| --- | --- |
| `V` | 移动（选中、拖动、调整已有标注） |
| `B` | 画笔 |
| `A` | 箭头 |
| `U` | 矩形 |
| `T` | 文字 |
| `⌘Z` / `⌘⇧Z` | 撤销 / 重做 |
| 按住 `H` | 临时隐藏标注，对照未标注的原图 |
| `Delete` | 删除选中的标注 |
| 空格 + 拖拽 | 平移画面 |
| `⌘ +` `⌘ -` `⌘ 0` | 放大 / 缩小 / 适应窗口 |
| `←` `→` | 上一张 / 下一张 |
| `Esc` | 返回相册 |

和 PS 一样，只有切到**移动工具（V）**才能选中和调整已经画好的标注；用画笔等工具时不会误选中它们。

## 开发

```bash
./start-app.sh
```

首次运行需要编译 Rust 依赖，耗时较长。技术细节见 [docs/architecture.md](docs/architecture.md)，待办见 [docs/design.md](docs/design.md)。

技术栈：Tauri 2 + React/TypeScript + Konva.js + printpdf。

## 打包

**macOS 本地打：**

```bash
./scripts/build-mac.sh            # 通用包，Intel 与 Apple Silicon 都能装
./scripts/build-mac.sh --native   # 只编当前架构，快一些，自己用够了
```

**Windows 得走 GitHub Actions。** Tauri 需要 MSVC 链接器和 Windows 侧的 WebView2 依赖，
官方不支持从 macOS 交叉编译，本地打不出来。推一个 tag 即可两个平台一起出包：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

产物会传到 GitHub Release（默认存为草稿，确认无误后再手动发布）。
也可以在仓库的 Actions 页面手动触发试跑。

### 发给别人时注意

**macOS 只能发 `.dmg`，不要发 `.app`。** `.app` 其实是个文件夹，里面有符号链接和可执行权限，
经微信、QQ 这类聊天软件转发（会被压缩再解压）就会损坏，对方打开必然报「已损坏」。
`.dmg` 是单个磁盘映像文件，转发不会破坏内部结构。

包做了 ad-hoc 签名但没有 Apple 开发者证书签名与公证，对方首次打开时系统会拦一下：

- **macOS**：Control + 点击图标 →「打开」→ 再点「打开」，只需做一次。
  真出现「已损坏」时用 `xattr -dr com.apple.quarantine /Applications/拾光笺.app` 修复。
- **Windows**：SmartScreen 提示时选「更多信息」→「仍要运行」。

> ad-hoc 签名不能让系统信任这个应用，但能避免最吓人的那个「已损坏，应该移到废纸篓」——
> 完全没签名的应用配上下载来的 quarantine 标记就是这个提示，且没有右键打开这条出路。
> 想彻底免掉提示需要 Apple 开发者账号（99 美元/年）做签名和公证。

打包脚本会在 `.dmg` 旁边生成一份「首次打开说明.txt」，转发时可以一并发过去。

## 图标

图标源文件是 [`src-tauri/assets/icon-source.svg`](src-tauri/assets/icon-source.svg)，改完跑：

```bash
./scripts/make-icon.sh
```

会用 Chrome 无头模式把 SVG 渲染成 1024px PNG，再生成各平台全套图标。
