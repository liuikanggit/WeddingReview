import { useCallback, useEffect, useRef, useState } from "react";
import AnnotationCanvas, { AnnotationCanvasHandle } from "../components/AnnotationCanvas";
import ChecklistPanel from "../components/ChecklistPanel";
import { useAlbumStore } from "../store/useAlbumStore";
import { notify } from "../store/useToast";
import {
  loadFull,
  loadPreview,
  neighborsOf,
  peekFull,
  peekPreview,
  prefetchPreviews,
  PREVIEW_MAX_DIM,
  type PhotoPreview,
} from "../lib/photoCache";
import type { AnnotationShape } from "../types/annotation";

interface Props {
  fileName: string;
  photoFiles: string[];
  onBack: () => void;
  onNavigate: (fileName: string) => void;
}

const BackIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h11a4.5 4.5 0 0 1 0 9H8" />
    <path d="M7 4L4 7l3 3" />
  </svg>
);
const ChevronLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 6l-6 6 6 6" />
  </svg>
);
const ChevronRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 6l6 6-6 6" />
  </svg>
);

export default function PhotoEditorView({ fileName, photoFiles, onBack, onNavigate }: Props) {
  const folderPath = useAlbumStore((s) => s.folderPath)!;
  const project = useAlbumStore((s) => s.project);
  const updatePhotoRecord = useAlbumStore((s) => s.updatePhotoRecord);
  const commitAnnotations = useAlbumStore((s) => s.commitAnnotations);
  const undoAnnotations = useAlbumStore((s) => s.undoAnnotations);
  const redoAnnotations = useAlbumStore((s) => s.redoAnnotations);
  // 历史存在 store 里按文件名分桶，翻走再翻回来依然能撤销
  const history = useAlbumStore((s) => s.histories[fileName]);
  const addChecklistItem = useAlbumStore((s) => s.addChecklistItem);
  const removeChecklistItem = useAlbumStore((s) => s.removeChecklistItem);

  // 命中缓存就同步拿到，翻页时不会闪一下空白
  const [photo, setPhoto] = useState<PhotoPreview | null>(() => peekPreview(folderPath, fileName) ?? null);
  const [fullSrc, setFullSrc] = useState<string | null>(() => peekFull(folderPath, fileName) ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canvasRef = useRef<AnnotationCanvasHandle>(null);

  useEffect(() => {
    let cancelled = false;
    const cachedPreview = peekPreview(folderPath, fileName);
    const cachedFull = peekFull(folderPath, fileName);
    setPhoto(cachedPreview ?? null);
    setFullSrc(cachedFull ?? null);
    setLoadError(null);

    if (!cachedPreview) {
      loadPreview(folderPath, fileName)
        .then((loaded) => {
          if (!cancelled) setPhoto(loaded);
        })
        .catch((err) => {
          if (!cancelled) setLoadError(String(err));
        });
    }

    // 预取相邻照片的预览图，让翻页几乎无等待
    prefetchPreviews(folderPath, neighborsOf(photoFiles, fileName));

    return () => {
      cancelled = true;
    };
  }, [folderPath, fileName, photoFiles]);

  /**
   * 放大到预览图撑不住时才去取原图（约 350% 以上）。
   * 翻页一律不碰原图——那是之前连续切换会卡死的根源。
   */
  const handleNeedFullRes = useCallback(() => {
    if (fullSrc || peekFull(folderPath, fileName)) {
      setFullSrc((prev) => prev ?? peekFull(folderPath, fileName) ?? null);
      return;
    }
    loadFull(folderPath, fileName)
      .then((src) => setFullSrc(src))
      .catch(() => undefined);
  }, [folderPath, fileName, fullSrc]);

  const record = project.photos[fileName];
  const annotations = (record?.annotations ?? []) as AnnotationShape[];
  const checkedItemIds = record?.checkedItemIds ?? [];
  const note = record?.note ?? "";

  const index = photoFiles.indexOf(fileName);
  const hasPrev = index > 0;
  const hasNext = index !== -1 && index < photoFiles.length - 1;

  // 到头了要明确告诉用户，而不是按键毫无反应——那会让人以为程序卡住了
  const goPrev = useCallback(() => {
    if (hasPrev) onNavigate(photoFiles[index - 1]);
    else notify("已经是第一张了");
  }, [hasPrev, index, photoFiles, onNavigate]);

  const goNext = useCallback(() => {
    if (hasNext) onNavigate(photoFiles[index + 1]);
    else notify("已经是最后一张了");
  }, [hasNext, index, photoFiles, onNavigate]);

  // 左右方向键翻页，Esc 返回相册（输入框聚焦时不拦截）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "Escape") onBack();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goPrev, goNext, onBack]);

  function toggleChecklistItem(id: string) {
    const next = checkedItemIds.includes(id)
      ? checkedItemIds.filter((i) => i !== id)
      : [...checkedItemIds, id];
    updatePhotoRecord(fileName, { checkedItemIds: next });
  }

  const markCount = annotations.length + checkedItemIds.length + (note.trim() ? 1 : 0);

  return (
    <div className="photo-editor">
      <header className="editor-header">
        <button className="ghost-btn" onClick={onBack} title="返回相册（Esc）">
          <BackIcon />
          相册
        </button>

        <div className="editor-identity">
          <span className="editor-filename">{fileName}</span>
          {markCount > 0 && <span className="editor-mark-count">{markCount} 处批注</span>}
        </div>

        <div className="editor-nav">
          {/* 到头的按钮不置灰禁用，而是保持可点：点了会明确告知原因，而不是毫无反应 */}
          <button
            className={`ghost-btn icon-only ${hasPrev ? "" : "is-exhausted"}`}
            onClick={goPrev}
            title="上一张（←）"
          >
            <ChevronLeft />
          </button>
          <span className="editor-position">
            {index + 1}
            <i>/</i>
            {photoFiles.length}
          </span>
          <button
            className={`ghost-btn icon-only ${hasNext ? "" : "is-exhausted"}`}
            onClick={goNext}
            title="下一张（→）"
          >
            <ChevronRight />
          </button>
        </div>
      </header>

      <div className="editor-body">
        <div className="editor-stage">
          {photo ? (
            <AnnotationCanvas
              key={fileName}
              ref={canvasRef}
              // 原图就位后无缝替换预览图，放大即可看到真实像素
              imageSrc={fullSrc ?? photo.src}
              naturalWidth={photo.width}
              naturalHeight={photo.height}
              sourceMaxDim={
                fullSrc
                  ? Math.max(photo.width, photo.height)
                  : Math.min(Math.max(photo.width, photo.height), PREVIEW_MAX_DIM)
              }
              onNeedFullRes={handleNeedFullRes}
              annotations={annotations}
              onChange={(shapes) => commitAnnotations(fileName, shapes)}
              onUndo={() => undoAnnotations(fileName)}
              onRedo={() => redoAnnotations(fileName)}
              canUndo={(history?.past.length ?? 0) > 0}
              canRedo={(history?.future.length ?? 0) > 0}
            />
          ) : loadError ? (
            <div className="stage-message error">{loadError}</div>
          ) : (
            <div className="stage-message">
              <span className="spinner" />
              加载照片
            </div>
          )}
        </div>

        <ChecklistPanel
          library={project.checklistLibrary}
          checkedItemIds={checkedItemIds}
          note={note}
          onToggleItem={toggleChecklistItem}
          onAddItem={addChecklistItem}
          onRemoveItem={removeChecklistItem}
          onNoteChange={(text) => updatePhotoRecord(fileName, { note: text })}
        />
      </div>
    </div>
  );
}
