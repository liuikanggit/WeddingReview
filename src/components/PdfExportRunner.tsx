import { useEffect, useRef, useState } from "react";
import AnnotationCanvas, { AnnotationCanvasHandle } from "./AnnotationCanvas";
import { useAlbumStore } from "../store/useAlbumStore";
import { exportPdf, PhotoExportInput } from "../lib/tauri";
import { loadPreview } from "../lib/photoCache";
import type { AnnotationShape } from "../types/annotation";

interface Props {
  outputPath: string;
  onDone: (error: string | null) => void;
}

/** 逐张把原图 + 标注渲染成合成 PNG，收集齐后一次性交给 Rust 端生成 PDF */
export default function PdfExportRunner({ outputPath, onDone }: Props) {
  const folderPath = useAlbumStore((s) => s.folderPath)!;
  const photoFiles = useAlbumStore((s) => s.photoFiles);
  const project = useAlbumStore((s) => s.project);

  const [index, setIndex] = useState(0);
  const [current, setCurrent] = useState<{
    fileName: string;
    src: string;
    w: number;
    h: number;
  } | null>(null);

  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const resultsRef = useRef<PhotoExportInput[]>([]);
  const finishedRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (finishedRef.current) return;

    if (index >= photoFiles.length) {
      finishedRef.current = true;
      exportPdf(outputPath, resultsRef.current)
        .then(() => onDoneRef.current(null))
        .catch((err) => onDoneRef.current(String(err)));
      return;
    }

    const fileName = photoFiles[index];
    let cancelled = false;
    (async () => {
      try {
        // 用 2000px 预览图即可：导出目标是 1800px，画质无损失，但比逐张读原图快一个量级
        const { src, width, height } = await loadPreview(folderPath, fileName);
        if (!cancelled) setCurrent({ fileName, src, w: width, h: height });
      } catch (err) {
        // 单张读取失败就跳过，不让整份 PDF 卡住
        console.error(`导出跳过 ${fileName}`, err);
        if (!cancelled) setIndex((i) => i + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index, photoFiles, folderPath, outputPath]);

  function handleImageReady() {
    if (!current) return;
    // 等一帧让 Konva 完成绘制再截图
    requestAnimationFrame(() => {
      const dataUrl = canvasRef.current?.exportComposite() ?? "";
      const record = project.photos[current.fileName];
      const checklistLines = (record?.checkedItemIds ?? [])
        .map((id) => project.checklistLibrary.find((item) => item.id === id)?.text)
        .filter((t): t is string => !!t);

      resultsRef.current.push({
        fileName: current.fileName,
        compositeImageBase64: dataUrl,
        checklistLines,
        note: record?.note ?? "",
      });
      setCurrent(null);
      setIndex((i) => i + 1);
    });
  }

  const done = Math.min(index, photoFiles.length);
  const percent = photoFiles.length ? (done / photoFiles.length) * 100 : 0;

  return (
    <div className="export-overlay">
      <div className="export-progress-box">
        <h3>正在生成 PDF</h3>
        <p className="export-sub">
          {done} / {photoFiles.length} 张
        </p>
        <div className="export-track">
          <div className="export-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>

      {current && (
        <div style={{ position: "fixed", top: -99999, left: -99999 }} aria-hidden>
          <AnnotationCanvas
            key={current.fileName}
            ref={canvasRef}
            readOnly
            imageSrc={current.src}
            naturalWidth={current.w}
            naturalHeight={current.h}
            annotations={(project.photos[current.fileName]?.annotations ?? []) as AnnotationShape[]}
            onChange={() => {}}
            onImageReady={handleImageReady}
          />
        </div>
      )}
    </div>
  );
}
