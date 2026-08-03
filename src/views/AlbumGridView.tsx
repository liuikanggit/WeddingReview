import { useEffect, useMemo } from "react";
import { useAlbumStore } from "../store/useAlbumStore";
import PhotoThumb from "../components/PhotoThumb";
import { prefetchPreviews } from "../lib/photoCache";

interface Props {
  onOpenPhoto: (fileName: string) => void;
  onExport: () => void;
  onSwitchAlbum: () => void;
}

/** 从完整路径里取最后一段作为相册名 */
function albumNameOf(folderPath: string) {
  const parts = folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

export default function AlbumGridView({ onOpenPhoto, onExport, onSwitchAlbum }: Props) {
  const { folderPath, photoFiles, project, thumbnails, thumbnailProgress } = useAlbumStore();

  const markCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const fileName of photoFiles) {
      const record = project.photos[fileName];
      if (!record) continue;
      map[fileName] =
        (record.annotations?.length ?? 0) +
        (record.checkedItemIds?.length ?? 0) +
        (record.note?.trim() ? 1 : 0);
    }
    return map;
  }, [photoFiles, project.photos]);

  const markedCount = useMemo(
    () => Object.values(markCounts).filter((n) => n > 0).length,
    [markCounts],
  );

  // 缩略图铺好后，空闲时先备好前几张的大图——"打开就点第一张"是最常见的动作
  useEffect(() => {
    if (!folderPath || thumbnailProgress || photoFiles.length === 0) return;
    const timer = setTimeout(() => prefetchPreviews(folderPath, photoFiles.slice(0, 4)), 400);
    return () => clearTimeout(timer);
  }, [folderPath, photoFiles, thumbnailProgress]);

  if (!folderPath) return null;

  const progressPercent = thumbnailProgress
    ? (thumbnailProgress.done / Math.max(1, thumbnailProgress.total)) * 100
    : 0;

  return (
    <div className="album-view">
      <header className="album-toolbar">
        <div className="album-title">
          <span className="album-name" title={folderPath}>
            {albumNameOf(folderPath)}
          </span>
          <span className="album-meta">
            <span>{photoFiles.length} 张照片</span>
            {markedCount > 0 && (
              <>
                <span className="dot" />
                <span className="marked">{markedCount} 张已批注</span>
              </>
            )}
          </span>
        </div>

        <div className="album-toolbar-actions">
          <button onClick={onSwitchAlbum}>切换相册</button>
          <button className="primary-btn" onClick={onExport} disabled={photoFiles.length === 0}>
            导出修图批注 PDF
          </button>
        </div>
      </header>

      {thumbnailProgress && (
        <div className="thumbnail-progress-bar">
          <div className="thumbnail-progress-track">
            <div className="thumbnail-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <span className="thumbnail-progress-count">
            正在生成缩略图 {thumbnailProgress.done} / {thumbnailProgress.total}
          </span>
        </div>
      )}

      {photoFiles.length === 0 ? (
        <div className="album-empty">这个文件夹里没有找到照片</div>
      ) : (
        <div className="photo-grid">
          {photoFiles.map((fileName) => (
            <PhotoThumb
              key={fileName}
              fileName={fileName}
              thumbSrc={thumbnails[fileName]}
              markCount={markCounts[fileName] ?? 0}
              onClick={() => onOpenPhoto(fileName)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
