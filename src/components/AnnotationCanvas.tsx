import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import Konva from "konva";
import { Stage, Layer, Group, Image as KonvaImage, Line, Arrow, Rect, Text } from "react-konva";
import { v4 as uuid } from "uuid";
import { notify } from "../store/useToast";
import type { AnnotationShape, EditorTool, RectShape } from "../types/annotation";

/**
 * 标注坐标系说明（很重要）：
 * 所有标注的坐标都存储在「基准坐标系」里——即原图等比缩放到最长边 BASE_MAX_DIM 后的尺寸。
 * 这个坐标系与窗口大小、当前缩放倍数都无关，所以窗口怎么拉伸、用户怎么缩放，
 * 已有标注的位置都不会漂移；导出 PDF 时按比例放大回目标分辨率即可。
 */
const BASE_MAX_DIM = 1400;
const COLORS = ["#c0392b", "#d9a441", "#2f6fed", "#2f9e59"];
const MIN_ZOOM_FACTOR = 0.5; // 相对「适应窗口」的最小倍数
const MAX_ZOOM_FACTOR = 8; // 相对「适应窗口」的最大倍数
const SELECT_COLOR = "#2f6fed";
const TEXT_PRESETS = ["瑕疵", "重点", "模糊", "遮挡", "去除"];
const ANNOTATION_NAME = "annotation";
/** 矩形尺寸手柄的标记：点手柄时不能被当成"点了空白"而取消选中 */
const HANDLE_NAME = "resize-handle";
/** 小于这个尺寸的矩形/箭头视为误点击，不生成标注 */
const MIN_SHAPE_SIZE = 4;
/** 矩形尺寸手柄在屏幕上的边长（会按画布缩放反算，保证视觉恒定） */
const HANDLE_SIZE = 10;
/** 按住它临时隐藏标注、对照原图 */
const HIDE_KEY = "h";

const TOOL_ORDER: EditorTool[] = ["move", "pen", "arrow", "rect", "text"];

const TOOL_LABELS: Record<EditorTool, string> = {
  move: "移动",
  pen: "画笔",
  arrow: "箭头",
  rect: "矩形",
  text: "文字",
};

/** 快捷键沿用 Photoshop 的习惯：V 移动、B 画笔、T 文字、U 形状 */
const TOOL_SHORTCUTS: Record<EditorTool, string> = {
  move: "v",
  pen: "b",
  arrow: "a",
  rect: "u",
  text: "t",
};

const SHORTCUT_TO_TOOL: Record<string, EditorTool> = Object.fromEntries(
  Object.entries(TOOL_SHORTCUTS).map(([tool, key]) => [key, tool as EditorTool]),
) as Record<string, EditorTool>;

const TOOL_ICONS: Record<EditorTool, ReactElement> = {
  move: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3.5l13 6.2-5.6 1.8-1.9 5.7z" />
    </svg>
  ),
  pen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20l3.2-.6a2 2 0 0 0 1.06-.56L18.5 7.6a1.8 1.8 0 0 0 0-2.55l-.55-.55a1.8 1.8 0 0 0-2.55 0L4.16 15.74a2 2 0 0 0-.56 1.06L3 20Z" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 19 19 5" />
      <path d="M9 5h10v10" />
    </svg>
  ),
  rect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 6h14M12 6v13" />
    </svg>
  ),
};

const EyeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

const EyeOffIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4l16 16" />
    <path d="M9.6 5.7A10.6 10.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a18 18 0 0 1-3.3 4.1" />
    <path d="M6.5 7.8A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.8" />
    <path d="M10.2 10.4a2.6 2.6 0 0 0 3.5 3.5" />
  </svg>
);

export interface AnnotationCanvasHandle {
  /** 导出与原图等分辨率的合成图（原图 + 标注），不受当前查看缩放/平移影响 */
  exportComposite: () => string;
}

interface Props {
  imageSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  annotations: AnnotationShape[];
  onChange: (shapes: AnnotationShape[]) => void;
  /** 静态导出模式：隐藏工具栏、禁用交互，图片加载完成后回调，供批量导出 PDF 时使用 */
  readOnly?: boolean;
  onImageReady?: () => void;
  /** 当前图源的最长边像素数，用于判断放大到什么程度才需要更高清的图源 */
  sourceMaxDim?: number;
  /** 当前图源已经不够清晰时触发，由上层决定是否去取原图 */
  onNeedFullRes?: () => void;
  /** 撤销/重做交给上层（历史按照片存在 store 里，翻走再翻回来依然可用），返回是否成功 */
  onUndo?: () => boolean;
  onRedo?: () => boolean;
  canUndo?: boolean;
  canRedo?: boolean;
}

interface TextEditorState {
  /** 基准坐标系里的落点 */
  canvasX: number;
  canvasY: number;
  /** 相对画布容器的位置，用于定位输入浮层 */
  screenX: number;
  screenY: number;
  value: string;
}

function useHtmlImage(src: string, onReady?: () => void) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    let cancelled = false;
    // 刻意不清空旧图：预览图升级为原图时要无缝替换，中途留白会闪一下。
    // 换照片时组件按 key 重新挂载，state 天然是空的，不需要在这里清。
    const img = new window.Image();
    img.onload = () => {
      if (!cancelled) {
        setImage(img);
        readyRef.current?.();
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return image;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, Props>(function AnnotationCanvas(
  {
    imageSrc,
    naturalWidth,
    naturalHeight,
    annotations,
    onChange,
    readOnly,
    onImageReady,
    sourceMaxDim,
    onNeedFullRes,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
  },
  ref,
) {
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Group>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const image = useHtmlImage(imageSrc, onImageReady);
  // 默认移动工具：刚进来通常是先看、先调整已有标注，而不是立刻画
  const [tool, setTool] = useState<EditorTool>("move");
  const [color, setColor] = useState(COLORS[0]);
  const drawingRef = useRef<AnnotationShape | null>(null);
  const [draft, setDraft] = useState<AnnotationShape | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  /** 按住时临时隐藏所有标注，用来对照未标注的原图 */
  const [hideAnnotations, setHideAnnotations] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  /** 绝对缩放倍数与平移量，作用在承载图片+标注的 Group 上 */
  const [view, setView] = useState({ scale: 0, x: 0, y: 0 });

  /** 只有移动工具下才可以选中、拖动、缩放已有标注（和 Photoshop 一致） */
  const selectMode = !readOnly && tool === "move" && !spacePressed;

  // 基准坐标系尺寸：标注坐标都存在这个坐标系里
  const { baseWidth, baseHeight } = useMemo(() => {
    const ratio = Math.min(1, BASE_MAX_DIM / Math.max(naturalWidth, naturalHeight));
    return {
      baseWidth: Math.max(1, Math.round(naturalWidth * ratio)),
      baseHeight: Math.max(1, Math.round(naturalHeight * ratio)),
    };
  }, [naturalWidth, naturalHeight]);

  // 导出模式下画布就是基准尺寸本身，不做任何适配
  const stageWidth = readOnly ? baseWidth : viewport.width;
  const stageHeight = readOnly ? baseHeight : viewport.height;

  /** 图片完整装进视口所需的缩放倍数（四周留一点余白，让照片浮在看片台上而不是贴死） */
  const fitScale = useMemo(() => {
    if (readOnly) return 1;
    if (!viewport.width || !viewport.height) return 0;
    const inset = 32;
    return Math.min(
      Math.max(1, viewport.width - inset * 2) / baseWidth,
      Math.max(1, viewport.height - inset * 2) / baseHeight,
    );
  }, [readOnly, viewport.width, viewport.height, baseWidth, baseHeight]);

  /**
   * 把平移量钳制在合理范围内——这是"无限画布"问题的根治点：
   * 内容比视口小就强制居中，比视口大也不允许拖出边界留白。
   */
  const clampPan = useCallback(
    (x: number, y: number, scale: number) => {
      const contentWidth = baseWidth * scale;
      const contentHeight = baseHeight * scale;
      const nextX =
        contentWidth <= viewport.width
          ? (viewport.width - contentWidth) / 2
          : clamp(x, viewport.width - contentWidth, 0);
      const nextY =
        contentHeight <= viewport.height
          ? (viewport.height - contentHeight) / 2
          : clamp(y, viewport.height - contentHeight, 0);
      return { x: nextX, y: nextY };
    },
    [baseWidth, baseHeight, viewport.width, viewport.height],
  );

  const resetView = useCallback(() => {
    if (!fitScale) return;
    setView({ scale: fitScale, ...clampPan(0, 0, fitScale) });
  }, [fitScale, clampPan]);

  // 监听画布容器尺寸，窗口缩放时保持视口正确
  useLayoutEffect(() => {
    if (readOnly) return;
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      // 尺寸没真的变就返回同一个对象，避免 ResizeObserver ↔ canvas 尺寸互相触发的反馈循环
      setViewport((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [readOnly]);

  // 首次拿到视口尺寸时设为「适应窗口」。
  // 注意不能依赖 imageSrc：预览图升级为原图时图源会变，但那不是换照片，
  // 若跟着重置就会把用户当前的缩放/平移打回去（表现为放大到一半突然跳一下）。
  // 真正换照片时组件按 key 重新挂载，state 天然是新的。
  useEffect(() => {
    if (readOnly || !fitScale) return;
    setView((v) => (v.scale === 0 ? { scale: fitScale, ...clampPan(0, 0, fitScale) } : v));
  }, [readOnly, fitScale, clampPan]);

  // 视口尺寸变化（改窗口大小）时只重新钳制平移，保留用户的缩放倍数
  useEffect(() => {
    if (readOnly) return;
    setView((v) => (v.scale === 0 ? v : { ...v, ...clampPan(v.x, v.y, v.scale) }));
  }, [readOnly, clampPan]);

  useImperativeHandle(ref, () => ({
    exportComposite() {
      const stage = stageRef.current;
      const content = contentRef.current;
      if (!stage || !content) return "";

      // 导出前把画布还原成基准坐标系的 1:1 状态，导出后再恢复用户当前的查看状态
      const prevStageSize = { width: stage.width(), height: stage.height() };
      const prevScale = content.scale() ?? { x: 1, y: 1 };
      const prevPos = content.position();

      stage.size({ width: baseWidth, height: baseHeight });
      content.scale({ x: 1, y: 1 });
      content.position({ x: 0, y: 0 });

      // 不按原图分辨率导出：A4 页面上半幅约 180mm 宽，1800px 已超过 250dpi，
      // 而按原图（常见 5000px+）会让每张 base64 涨到几十 MB，几十张叠起来直接吃掉上 GB 内存。
      const targetWidth = Math.min(naturalWidth, 1800);
      const dataUrl = stage.toDataURL({
        pixelRatio: targetWidth / baseWidth,
        mimeType: "image/jpeg",
        quality: 0.92,
      });

      stage.size(prevStageSize);
      content.scale(prevScale);
      content.position(prevPos);
      return dataUrl;
    },
  }));

  /** 正在用手柄改尺寸的矩形（拖动过程中先本地预览，松手才写回） */
  const [resizingRect, setResizingRect] = useState<RectShape | null>(null);
  /** 本次拖动开始时的原始矩形，作为尺寸换算的固定基准 */
  const resizeBaseRef = useRef<RectShape | null>(null);

  /** 所有对标注的修改都走这里，才能被撤销 */
  const commit = useCallback(
    (next: AnnotationShape[]) => {
      onChange(next);
    },
    [onChange],
  );

  // 离开移动工具就取消选中，避免绘制时残留选中框
  useEffect(() => {
    if (!selectMode) setSelectedId(null);
  }, [selectMode]);

  const undo = useCallback(() => {
    if (!onUndo?.()) notify("没有可撤销的操作了");
    else setSelectedId(null);
  }, [onUndo]);

  const redo = useCallback(() => {
    if (!onRedo?.()) notify("没有可重做的操作了");
    else setSelectedId(null);
  }, [onRedo]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) {
      notify(
        annotations.length === 0
          ? "这张照片还没有标注"
          : "先用移动工具（V）选中要删除的标注",
      );
      return;
    }
    commit(annotations.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  }, [annotations, commit, selectedId]);

  const zoomBy = useCallback(
    (factor: number, anchor?: { x: number; y: number }, silent = false) => {
      if (!fitScale) return;
      setView((v) => {
        const min = fitScale * MIN_ZOOM_FACTOR;
        const max = fitScale * MAX_ZOOM_FACTOR;
        const nextScale = clamp(v.scale * factor, min, max);

        // 已经顶到缩放上下限就说明白，别让人反复按却毫无变化
        if (!silent && nextScale === v.scale) {
          if (factor > 1) notify("已经放到最大了");
          else if (factor < 1) notify("已经缩到最小了");
          return v;
        }
        const point = anchor ?? { x: viewport.width / 2, y: viewport.height / 2 };
        // 让锚点（鼠标位置或视口中心）在缩放前后指向同一处内容
        const contentPoint = { x: (point.x - v.x) / v.scale, y: (point.y - v.y) / v.scale };
        const raw = {
          x: point.x - contentPoint.x * nextScale,
          y: point.y - contentPoint.y * nextScale,
        };
        return { scale: nextScale, ...clampPan(raw.x, raw.y, nextScale) };
      });
    },
    [fitScale, clampPan, viewport.width, viewport.height],
  );

  // 快捷键：空格抓手、撤销、切换工具、删除选中、缩放、退出
  useEffect(() => {
    if (readOnly) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpacePressed(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        // ⌘⇧Z 重做，⌘Z 撤销
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomBy(1.2);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        zoomBy(1 / 1.2);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        resetView();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // 按住 H 临时隐藏标注，用来对照原图
      if (e.key.toLowerCase() === HIDE_KEY) {
        if (!e.repeat) setHideAnnotations(true);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setTextEditor(null);
        return;
      }
      const shortcut = SHORTCUT_TO_TOOL[e.key.toLowerCase()];
      if (shortcut) setTool(shortcut);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpacePressed(false);
      if (e.key.toLowerCase() === HIDE_KEY) setHideAnnotations(false);
    }
    // 切到别的窗口时按键抬起收不到，兜底复位，免得一直卡在隐藏状态
    function onBlur() {
      setSpacePressed(false);
      setHideAnnotations(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [readOnly, selectedId, undo, redo, deleteSelected, zoomBy, resetView]);

  /** 指针在基准坐标系里的位置 */
  function pointerInContent() {
    return contentRef.current?.getRelativePointerPosition() ?? { x: 0, y: 0 };
  }

  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition() ?? undefined;

    if (e.evt.ctrlKey || e.evt.metaKey) {
      // 触控板捏合会被浏览器映射成带 ctrlKey 的 wheel 事件；
      // 连续手势顶到极限时不提示，否则捏合过程会被提示刷屏
      zoomBy(1 - e.evt.deltaY * 0.01, pointer, true);
    } else {
      // 双指滚动平移，同样受边界钳制，不会出现"无限画布"
      setView((v) => ({
        scale: v.scale,
        ...clampPan(v.x - e.evt.deltaX, v.y - e.evt.deltaY, v.scale),
      }));
    }
  }

  function commitText(rawText: string) {
    const text = rawText.trim();
    if (text && textEditor) {
      commit([
        ...annotations,
        {
          id: uuid(),
          tool: "text",
          color,
          x: textEditor.canvasX,
          y: textEditor.canvasY,
          text,
          fontSize: 24,
        },
      ]);
    }
    setTextEditor(null);
  }

  function handleMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (readOnly || spacePressed || e.evt.button !== 0) return;

    // 移动工具只负责选中/搬动：点空白处取消选中，点图形或尺寸手柄都交给它们自己处理。
    // 注意必须把手柄排除掉——否则一按下手柄就取消选中，手柄当场消失，根本拖不动。
    if (tool === "move") {
      if (!e.target.hasName(ANNOTATION_NAME) && !e.target.hasName(HANDLE_NAME)) {
        setSelectedId(null);
      }
      return;
    }

    // 绘制工具下已有标注不监听事件，这里点到的一定是背景或空白
    setSelectedId(null);
    setTextEditor(null);

    const { x, y } = pointerInContent();
    // 点到图片外的留白区域不产生标注
    if (x < 0 || y < 0 || x > baseWidth || y > baseHeight) return;

    if (tool === "text") {
      const screen = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 };
      setTextEditor({ canvasX: x, canvasY: y, screenX: screen.x, screenY: screen.y, value: "" });
      return;
    }

    let shape: AnnotationShape;
    if (tool === "pen") {
      shape = { id: uuid(), tool: "pen", color, points: [x, y], strokeWidth: 5 };
    } else if (tool === "arrow") {
      shape = { id: uuid(), tool: "arrow", color, points: [x, y, x, y], strokeWidth: 5 };
    } else {
      shape = { id: uuid(), tool: "rect", color, x, y, width: 0, height: 0, strokeWidth: 4 };
    }
    drawingRef.current = shape;
    setDraft(shape);
  }

  /**
   * 绘制过程中的移动/抬起挂在 window 上，而不是画布上：
   * 这样鼠标拖出画布边界再松开也不会丢掉这一笔，是绘图工具应有的手感。
   */
  useEffect(() => {
    if (readOnly) return;

    function updateDraft() {
      const current = drawingRef.current;
      if (!current) return;
      const raw = pointerInContent();
      // 允许贴边绘制，但不越过图片边界
      const x = clamp(raw.x, 0, baseWidth);
      const y = clamp(raw.y, 0, baseHeight);

      if (current.tool === "pen") {
        const updated = { ...current, points: [...current.points, x, y] };
        drawingRef.current = updated;
        setDraft(updated);
      } else if (current.tool === "arrow") {
        const updated = { ...current, points: [current.points[0], current.points[1], x, y] };
        drawingRef.current = updated;
        setDraft(updated);
      } else if (current.tool === "rect") {
        const updated = { ...current, width: x - current.x, height: y - current.y };
        drawingRef.current = updated;
        setDraft(updated);
      }
    }

    function onMove(e: MouseEvent) {
      if (!drawingRef.current) return;
      // 让 Konva 用这次原生事件刷新指针位置，否则拿到的还是上一次的坐标
      stageRef.current?.setPointersPositions(e);
      updateDraft();
    }

    function onUp() {
      const current = drawingRef.current;
      drawingRef.current = null;
      setDraft(null);
      if (!current) return;

      // 过滤掉误点击产生的空标注，并把反向拖拽的矩形规范成正的宽高
      if (current.tool === "rect") {
        const width = Math.abs(current.width);
        const height = Math.abs(current.height);
        if (width < MIN_SHAPE_SIZE || height < MIN_SHAPE_SIZE) return;
        commit([
          ...annotations,
          {
            ...current,
            x: Math.min(current.x, current.x + current.width),
            y: Math.min(current.y, current.y + current.height),
            width,
            height,
          },
        ]);
        return;
      }
      if (current.tool === "arrow") {
        const [x1, y1, x2, y2] = current.points;
        if (Math.hypot(x2 - x1, y2 - y1) < MIN_SHAPE_SIZE) return;
      }
      if (current.tool === "pen" && current.points.length < 4) return;

      commit([...annotations, current]);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [readOnly, annotations, onChange, baseWidth, baseHeight]);

  function clearAll() {
    if (annotations.length === 0) {
      notify("这张照片还没有标注");
      return;
    }
    if (window.confirm("清空这张照片的所有标注？")) {
      commit([]);
      setSelectedId(null);
      notify("已清空这张照片的标注");
    }
  }

  /**
   * 自绘的矩形尺寸手柄。
   *
   * 这里不用 Konva 的 Transformer：它重写了 getAbsoluteTransform() 直接返回自身 transform，
   * 刻意忽略父节点变换——也就是说它假定自己不在被缩放的容器里。而我们的标注挂在一个
   * 承载缩放/平移的 Group 下，于是它的内部定位算的是一套坐标、实际渲染又是另一套，
   * 表现就是手柄大小失真、点不中。自己画四个角，几何关系完全可控。
   */
  function renderRectHandles(shape: RectShape) {
    const inv = 1 / (view.scale || 1);
    const size = HANDLE_SIZE * inv; // 屏幕上恒定大小
    const corners: { id: string; x: number; y: number; cursor: string }[] = [
      { id: "tl", x: shape.x, y: shape.y, cursor: "nwse-resize" },
      { id: "tr", x: shape.x + shape.width, y: shape.y, cursor: "nesw-resize" },
      { id: "bl", x: shape.x, y: shape.y + shape.height, cursor: "nesw-resize" },
      { id: "br", x: shape.x + shape.width, y: shape.y + shape.height, cursor: "nwse-resize" },
    ];

    /**
     * 拖某个角时对角固定，用四条边重新推出规范化的矩形。
     * 基准始终取拖动开始那一刻的矩形——若拿上一帧的预览值迭代，
     * 一旦拖过头发生翻转，"对角"的含义就变了，位置会跳。
     */
    function resizeFrom(id: string, px: number, py: number): RectShape {
      const base = resizeBaseRef.current ?? shape;
      let left = base.x;
      let top = base.y;
      let right = base.x + base.width;
      let bottom = base.y + base.height;
      if (id === "tl" || id === "bl") left = px;
      else right = px;
      if (id === "tl" || id === "tr") top = py;
      else bottom = py;
      return {
        ...base,
        x: clamp(Math.min(left, right), 0, baseWidth),
        y: clamp(Math.min(top, bottom), 0, baseHeight),
        width: Math.max(MIN_SHAPE_SIZE, Math.abs(right - left)),
        height: Math.max(MIN_SHAPE_SIZE, Math.abs(bottom - top)),
      };
    }

    return corners.map((corner) => (
      <Rect
        key={`${shape.id}-${corner.id}`}
        name={HANDLE_NAME}
        x={corner.x}
        y={corner.y}
        width={size}
        height={size}
        offsetX={size / 2}
        offsetY={size / 2}
        fill="#fff"
        stroke={SELECT_COLOR}
        strokeWidth={1.5 * inv}
        cornerRadius={2 * inv}
        // 手柄本身很小，放宽命中范围，避免"看得见点不中"
        hitStrokeWidth={HANDLE_SIZE * inv}
        draggable
        onMouseEnter={(e) => {
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = corner.cursor;
        }}
        onMouseLeave={(e) => {
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = "";
        }}
        onDragStart={() => {
          resizeBaseRef.current = shape;
        }}
        onDragMove={(e) => {
          setResizingRect(resizeFrom(corner.id, e.target.x(), e.target.y()));
        }}
        onDragEnd={(e) => {
          const next = resizeFrom(corner.id, e.target.x(), e.target.y());
          resizeBaseRef.current = null;
          setResizingRect(null);
          updateShape(shape.id, {
            x: next.x,
            y: next.y,
            width: next.width,
            height: next.height,
          });
        }}
      />
    ));
  }

  function updateShape(id: string, patch: Partial<AnnotationShape>) {
    commit(annotations.map((s) => (s.id === id ? ({ ...s, ...patch } as AnnotationShape) : s)));
  }

  function renderShape(shape: AnnotationShape, interactive: boolean) {
    const selected = interactive && selectedId === shape.id;
    // 移动工具下直接可拖，不用先点一下选中——和 Photoshop 的移动工具手感一致
    const common = {
      name: ANNOTATION_NAME,
      listening: interactive,
      draggable: interactive,
      onMouseDown: () => interactive && setSelectedId(shape.id),
      onDragStart: () => setSelectedId(shape.id),
      shadowColor: SELECT_COLOR,
      shadowBlur: selected ? 12 : 0,
      shadowOpacity: selected ? 0.9 : 0,
    };

    switch (shape.tool) {
      case "pen":
        return (
          <Line
            key={shape.id}
            {...common}
            points={shape.points}
            stroke={shape.color}
            strokeWidth={shape.strokeWidth}
            lineCap="round"
            lineJoin="round"
            tension={0.2}
            hitStrokeWidth={Math.max(12, shape.strokeWidth * 3)}
            onDragEnd={(e) => {
              // 线类图形用整体位移表达拖动：把偏移并回点集，再把节点位置归零
              const node = e.target;
              const dx = node.x();
              const dy = node.y();
              node.position({ x: 0, y: 0 });
              updateShape(shape.id, {
                points: shape.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
              });
            }}
          />
        );
      case "arrow":
        return (
          <Arrow
            key={shape.id}
            {...common}
            points={shape.points}
            stroke={shape.color}
            fill={shape.color}
            strokeWidth={shape.strokeWidth}
            pointerLength={Math.max(10, shape.strokeWidth * 2.4)}
            pointerWidth={Math.max(10, shape.strokeWidth * 2.4)}
            hitStrokeWidth={Math.max(12, shape.strokeWidth * 3)}
            onDragEnd={(e) => {
              const node = e.target;
              const dx = node.x();
              const dy = node.y();
              node.position({ x: 0, y: 0 });
              updateShape(shape.id, {
                points: shape.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
              });
            }}
          />
        );
      case "rect":
        return (
          <Rect
            key={shape.id}
            {...common}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            stroke={shape.color}
            strokeWidth={shape.strokeWidth}
            onDragEnd={(e) => updateShape(shape.id, { x: e.target.x(), y: e.target.y() })}
          />
        );
      case "text":
        return (
          <Text
            key={shape.id}
            {...common}
            x={shape.x}
            y={shape.y}
            text={shape.text}
            fontSize={shape.fontSize}
            fontStyle="bold"
            fill={shape.color}
            stroke="#ffffff"
            strokeWidth={selected ? 0 : 3}
            fillAfterStrokeEnabled
            onDragEnd={(e) => updateShape(shape.id, { x: e.target.x(), y: e.target.y() })}
          />
        );
    }
  }

  /** 当前选中的矩形（只有矩形才显示尺寸手柄） */
  const selectedRectBase = annotations.find(
    (s): s is RectShape => s.id === selectedId && s.tool === "rect",
  );
  const selectedRect = resizingRect ?? selectedRectBase;

  const zoomPercent = fitScale ? Math.round((view.scale / fitScale) * 100) : 100;

  /**
   * 只有当屏幕上要显示的像素**超过当前图源本身的分辨率**时，这张图才真的开始糊，
   * 那时候才值得去换原图。2000px 的预览图能一直撑到约 350% 缩放，
   * 在此之前拉原图纯属浪费——那正是"放大到 128% 会顿一下"的原因。
   * 再加一个防抖：捏合手势进行中去读十几 MB 的原图会让缩放发涩，等手停下来再取。
   */
  const needFullResRef = useRef(onNeedFullRes);
  needFullResRef.current = onNeedFullRes;
  useEffect(() => {
    if (readOnly || !sourceMaxDim || view.scale <= 0) return;
    const displayedMaxDim = Math.max(baseWidth, baseHeight) * view.scale;
    if (displayedMaxDim <= sourceMaxDim * 1.02) return;
    const timer = setTimeout(() => needFullResRef.current?.(), 420);
    return () => clearTimeout(timer);
  }, [readOnly, sourceMaxDim, view.scale, baseWidth, baseHeight]);

  const contentTransform = {
    x: readOnly ? 0 : view.x,
    y: readOnly ? 0 : view.y,
    scaleX: readOnly ? 1 : view.scale,
    scaleY: readOnly ? 1 : view.scale,
  };

  const canvasBody = (
    <Stage
      ref={stageRef}
      width={stageWidth}
      height={stageHeight}
      onWheel={readOnly ? undefined : handleWheel}
      onMouseDown={readOnly ? undefined : handleMouseDown}
      style={
        readOnly
          ? undefined
          : {
              cursor: spacePressed
                ? "grab"
                : tool === "move"
                  ? "default"
                  : tool === "text"
                    ? "text"
                    : "crosshair",
            }
      }
    >
      {/* 照片单独一层：标注变化时不会连带重绘这张大图，拖动标注才不会整屏闪一下 */}
      <Layer listening={false}>
        <Group {...contentTransform}>
          {/* 阴影画在照片下面的矩形上，而不是照片本身：
              对一张几千万像素的图做 shadowBlur 极其昂贵，每次重绘都要算一遍，
              换成矩形后阴影只按轮廓算一次，几乎没有开销。 */}
          {image && !readOnly && (
            <Rect
              width={baseWidth}
              height={baseHeight}
              fill="#000"
              shadowColor="#000"
              shadowBlur={24}
              shadowOpacity={0.55}
              shadowOffsetY={6}
              listening={false}
            />
          )}
          {image && <KonvaImage image={image} width={baseWidth} height={baseHeight} />}
        </Group>
      </Layer>

      {/* 按住时整层不画：比逐个隐藏图形省事，也保证手柄一起消失 */}
      <Layer visible={!hideAnnotations}>
        <Group
          ref={contentRef}
          {...contentTransform}
          draggable={!readOnly && spacePressed}
          dragBoundFunc={(pos) => clampPan(pos.x, pos.y, view.scale)}
          onDragEnd={(e) => {
            if (e.target === contentRef.current) {
              setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
            }
          }}
        >
          {annotations.map((shape) =>
            renderShape(
              // 正在拖手柄改尺寸时先显示本地预览，松手才写回 store
              resizingRect && resizingRect.id === shape.id ? resizingRect : shape,
              selectMode,
            ),
          )}
          {draft && renderShape(draft, false)}
          {selectedRect && selectMode && renderRectHandles(selectedRect)}
        </Group>
      </Layer>
    </Stage>
  );

  if (readOnly) return canvasBody;

  return (
    <div className="canvas-shell">
      <div className="annotation-toolbar">
        {TOOL_ORDER.map((t) => (
          <button
            key={t}
            className={`tool-btn ${tool === t ? "active" : ""}`}
            onClick={() => setTool(t)}
            title={`${TOOL_LABELS[t]}（快捷键 ${TOOL_SHORTCUTS[t].toUpperCase()}）`}
          >
            {TOOL_ICONS[t]}
            {TOOL_LABELS[t]}
            <span className="tool-key">({TOOL_SHORTCUTS[t].toUpperCase()})</span>
          </button>
        ))}

        <span className="toolbar-divider" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={`color-swatch ${color === c ? "active" : ""}`}
            style={{ background: c }}
            onClick={() => {
              setColor(c);
              if (selectedId) updateShape(selectedId, { color: c });
            }}
            title="标注颜色"
          />
        ))}

        <span className="toolbar-divider" />
        {/* 这几个按钮不置灰禁用：点了会说明为什么用不了，比一个点不动的灰按钮更有用 */}
        <button
          className={canUndo ? "" : "is-exhausted"}
          onClick={undo}
          title="撤销上一步"
        >
          撤销
          <span className="tool-key">(⌘Z)</span>
        </button>
        <button
          className={canRedo ? "" : "is-exhausted"}
          onClick={redo}
          title="重做"
        >
          重做
          <span className="tool-key">(⌘⇧Z)</span>
        </button>
        <button
          className={selectedId ? "" : "is-exhausted"}
          onClick={deleteSelected}
          title="删除选中的标注"
        >
          删除选中
          <span className="tool-key">(⌫)</span>
        </button>
        <button className={annotations.length === 0 ? "is-exhausted" : ""} onClick={clearAll}>
          清空
        </button>

        <span className="toolbar-divider" />
        {/* 按住才生效：松开立刻恢复，方便快速对照 */}
        <button
          className={`tool-btn ${hideAnnotations ? "active" : ""}`}
          title="按住查看未标注的原图"
          onMouseDown={() => setHideAnnotations(true)}
          onMouseUp={() => setHideAnnotations(false)}
          onMouseLeave={() => setHideAnnotations(false)}
        >
          {hideAnnotations ? EyeOffIcon : EyeIcon}
          看原图
          <span className="tool-key">(按住 H)</span>
        </button>

      </div>

      <div className="canvas-viewport" ref={viewportRef}>
        {canvasBody}

        {/* 缩放控件浮在画布右下角，不占工具栏宽度 */}
        <div className="zoom-group">
          <button onClick={() => zoomBy(1 / 1.2)} title="缩小（⌘-）">
            −
          </button>
          <button className="zoom-value" onClick={resetView} title="适应窗口（⌘0）">
            {zoomPercent}%
          </button>
          <button onClick={() => zoomBy(1.2)} title="放大（⌘+）">
            ＋
          </button>
        </div>

        {textEditor && (
          <div
            className="text-annotation-popover"
            style={{ left: textEditor.screenX, top: textEditor.screenY }}
          >
            <div className="preset-chips">
              {TEXT_PRESETS.map((p) => (
                <button key={p} type="button" onClick={() => commitText(p)}>
                  {p}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commitText(textEditor.value);
              }}
            >
              <input
                autoFocus
                value={textEditor.value}
                onChange={(e) => setTextEditor((t) => t && { ...t, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setTextEditor(null);
                }}
                placeholder="自定义文字，回车确认"
              />
            </form>
          </div>
        )}
      </div>

      <div className="canvas-hint">
        {hideAnnotations
          ? "松开即可恢复标注"
          : tool === "move"
            ? "拖动标注可移动，矩形选中后可拉动手柄改大小 · Delete 删除 · 按住 H 看原图"
            : "切到移动工具（V）才能选中和调整已有标注 · 空格拖拽平移 · 按住 H 看原图"}
      </div>
    </div>
  );
});

export default AnnotationCanvas;
