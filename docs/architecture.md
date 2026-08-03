# 拾光笺 已实现架构

## 技术栈

- Tauri 2.x（Rust 后端 + WebView），产品名「拾光笺」
- 前端：React + TypeScript + Vite，状态管理用 zustand
- 批注画布：Konva.js / react-konva
- PDF 生成：Rust `printpdf`（内嵌 Noto Sans SC 中文字体，`subset_fonts` 控制体积）
- 图片解码/缩放：Rust `image` crate，批量任务用 `rayon`

## 数据流

1. 用户通过原生对话框（`tauri-plugin-dialog`）选择相册文件夹；打开成功的路径会记到应用配置目录下的 `last_album.json`，下次启动自动恢复，不用每次重选。
2. `open_album` 扫描文件夹里的图片（jpg/jpeg/png/heic/heif/webp），并读取该文件夹下 `.weddingreview/project.json`。这一步只做轻量元数据读取，**不等缩略图**——否则启动恢复相册时界面会被缩略图生成整个卡住，进度条也就无从显示。
3. 缩略图由 `ensure_thumbnails_batch` 批量生成（最长边 480px，缓存在 `.weddingreview/thumbnails/`），生成过程通过 `thumbnail-progress` 事件回报进度供前端展示进度条。
4. **图片一律走二进制 IPC，不走 data URL，也不走自定义资源协议。**
   - 资源协议（`asset://`）实测在某些真实相册路径下会在 WebView 层加载失败，Rust 侧收不到任何请求日志，不可靠。
   - data URL 更糟：一张十几 MB 的照片编码成 base64 是几千万字符的字符串，前端解析它是**同步**的，会把 WebView 主线程整个堵死——表现就是"连续切换照片时整个 app 像卡死一样"。
   - 现在 Rust 端用 `tauri::ipc::Response`（`InvokeResponseBody::Raw`）回传字节，前端拿 ArrayBuffer 包成 Blob 生成 `blob:` URL，全程不碰巨型字符串。blob URL 被 LRU 淘汰时必须 `revokeObjectURL`，否则内存不释放。

5. **照片分级加载**（Lightroom 的思路）：
   - 相册页用 480px 缩略图；
   - 编辑器默认用 2000px 预览图（约 280KB，比原图小 98%），翻页只读这个；
   - 只有当用户**放大超过 100%** 时才按需取原图——批注常要看清皮肤、杂物这类细节，那时才需要真实像素。翻页不会触发原图加载。
   - 打开相册后，`warm_previews` 在后台把整册预览图都备好，之后翻页就只是读小文件。
6. 每次标注、勾选、备注变更都会更新 zustand store，并防抖 500ms 后调用 `save_project` 写回 `.weddingreview/project.json`（sidecar 文件跟随相册文件夹移动）。
7. 导出 PDF：前端逐张隐藏渲染只读画布，把「预览图 + 标注」合成为一张 JPEG（宽度上限 1800px，2000px 预览足够覆盖），连同勾选的清单文字与备注交给 `export_pdf`，由 Rust 逐页排版成 PDF。

## 画布设计（`AnnotationCanvas`）

- **基准坐标系**：标注坐标存在「原图等比缩放到最长边 1400px」的坐标系里，与窗口尺寸、当前缩放倍数无关。窗口怎么拉伸、用户怎么缩放，已有标注都不会漂移；导出时按比例放大回目标分辨率即可。
- **固定视口**：Stage 尺寸等于容器尺寸，图片和标注挂在一个 Group 上，缩放/平移作用于该 Group。平移量经 `clampPan` 钳制——内容小于视口强制居中，大于视口也不允许拖出边界，杜绝「无限画布」。
- **命中判断**：背景图 `listening={false}`，判断是否点到已有标注用 `e.target.hasName("annotation")`，**不能**用「target 是不是 Stage」——画布上永远铺着背景图，那样判断会让绘制逻辑永远走不到。
- **绘制事件**：按下挂在画布上，移动/抬起挂在 window 上，鼠标拖出画布再松开也不会丢笔画。
- **ResizeObserver**：尺寸没真变时返回同一个 state 对象，避免与 canvas 尺寸变化形成反馈循环（该循环会让组件持续重渲染、effect 反复重建）。
- **双图层**：照片一层、标注一层。标注变化只重绘标注层，不会连带重绘那张大图和它的投影——否则拖动标注结束时整屏会闪一下。
- **工具语义（对齐 Photoshop）**：默认落在移动工具（V）——进来通常是先看、先调整已有标注，而不是立刻下笔。只有移动工具下标注才 `listening`、可选中可拖动；用画笔等工具时标注不响应事件，不会误选中。移动工具下标注直接 `draggable`，点击即可拖，不必先点一下选中。
- **矩形尺寸手柄是自绘的，没有用 Konva 的 Transformer**。Transformer 重写了 `getAbsoluteTransform()` 直接返回自身 transform、刻意忽略父节点变换，等于假定自己不在被缩放的容器里；而我们的标注挂在承载缩放/平移的 Group 下，它的内部定位算一套坐标、实际渲染又是另一套，表现为手柄尺寸失真且点不中。自绘四角手柄后几何关系完全可控，尺寸按 `1/scale` 反算保证屏幕上恒定。
- **手柄必须带自己的 name 并在空白判定里排除**：Stage 的 mousedown 在点手柄时同样会触发，若判成"点了空白"就取消选中，手柄会在按下的瞬间消失，于是永远拖不动。这一条对 Transformer 的 anchor 同样成立。
- **改尺寸时的基准要固定**：拖动过程中用拖动开始那一刻的矩形做换算基准，不要拿上一帧的预览值迭代——一旦拖过头发生翻转，"对角"的含义会变，位置就会跳。

## PDF 排版（`src-tauri/src/pdf/mod.rs`）

- A4 竖版，照片等比放进「内容宽 × 196mm」并水平居中，四周描浅灰细边（婚纱照多为高调浅色，不描边会与白纸融为一体）。
- 照片下方依次是文件名、勾选的修图要求、备注。文字按页面宽度换行（CJK 算一格、ASCII 算半格的粗略估算），续行有缩进对齐。
- 内容超过首页容量时**自动开续页**（标题带「（续）」），不做截断——修图要求不能因为排版而丢失。

## 数据模型（`.weddingreview/project.json`）

```
ProjectData
├─ checklistLibrary: [{ id, text }]     // 项目级常用清单条目库
└─ photos: {
     [文件名]: {
       annotations: Shape[]              // 画笔/箭头/矩形/文字，坐标基于基准坐标系
       checkedItemIds: string[]          // 勾选的清单条目 id
       note: string                       // 该照片专属备注
     }
   }
```

删除清单条目时会同步把该 id 从所有照片的勾选里摘掉，不留悬挂引用。

## 撤销历史与数据安全（两件不同的事）

- **撤销历史**管的是编辑手感：按文件名分桶存在 `useAlbumStore.histories` 里，翻到别的照片再翻回来依然可撤销；**只活在内存**，关掉应用即清空。设了每张 40 步、最多 40 张照片的上限，防止一次会话翻过几百张后内存无限增长。
  刻意不落盘：历史存的是每一步的完整标注快照，而画笔的 `points` 动辄几百个点，几十步乘几十张会把 `project.json` 从几十 KB 撑到 10MB 量级；而我们是**全量重写**该文件且带 500ms 防抖，等于每画一笔就重写 10MB，卡顿会立刻回来。何况几乎没有软件把 undo 跨会话保留。
- **数据安全**靠落盘快照：每次 `open_album` 时把现有 `project.json` 复制一份到 `.weddingreview/backups/project-<时间戳>.json`，保留最近 8 份。与最新一份内容相同则跳过，免得反复开关应用把有用的旧备份冲掉。这才是能兜住"整份批注被误清空"的机制——撤销历史兜不住，它关掉就没了。

## 反馈原则

**任何被拒绝或无效的操作都要给出反馈**——按键毫无反应会让人以为程序卡死了。
统一入口是 `src/store/useToast.ts` 的 `notify()`，出口是挂在 App 根部的 `ToastHost`。

已按此处理的场景：翻到第一张/最后一张、缩放到上下限、无内容可撤销、未选中就按删除、清空空相册。
对应的按钮不用 `disabled` 置灰锁死，而是保留可点击、视觉弱化（`.is-exhausted`），点了会说明原因——
一个点不动的灰按钮不会告诉用户任何事。

例外：连续手势（触控板捏合）顶到缩放极限时不提示，否则会被刷屏。

## 关键文件

- `src-tauri/src/models.rs` — 数据结构（`camelCase` 序列化，与前端 TS 类型对齐）
- `src-tauri/src/commands/project.rs` — 相册导入、项目数据读写、最近相册记忆
- `src-tauri/src/commands/photos.rs` — 批量缩略图（限流线程池）、原图与尺寸读取
- `src-tauri/src/commands/export.rs` + `src-tauri/src/pdf/mod.rs` — PDF 合成
- `src/components/AnnotationCanvas.tsx` — 批注画布，编辑与导出复用同一组件（`readOnly` 切换）
- `src/store/useAlbumStore.ts` — 全局状态与防抖持久化

## 踩过的坑（避免重复）

- 本地打 macOS DMG **必须带 `CI=true`**。Tauri 会用 AppleScript 让 Finder 摆放 DMG 窗口布局，
  这需要「自动化 → 控制 Finder」权限；终端没被授权时那步直接失败，而报错只有一句
  `error running bundle_dmg.sh`，完全看不出原因。`CI=true` 会让 Tauri 传 `--skip-jenkins`
  跳过美化，DMG 照常生成。GitHub Actions 里本来就有 `CI=true`，所以只有本地会踩到。

- `printpdf` 的 `images` feature **只引入 image crate 本身**，不启用任何具体格式解码；少了 `jpeg`/`png` 会让 `RawImage::decode_from_bytes` 直接失败，而这条路径不跑导出就不会暴露。
- WebKit 给 `<button>` 套了匿名内部布局盒，子元素的 `aspect-ratio` 会失效、内容被压扁——卡片类组件别用 button 当容器。
- `aspect-ratio` 在「flex 子项同时是 grid 容器」这层嵌套里也会被压缩掉，网格行高需要写死。
- 防抖保存必须在定时器回调里重新取最新状态，否则防抖窗口内的后续修改会被第一次的快照覆盖。
