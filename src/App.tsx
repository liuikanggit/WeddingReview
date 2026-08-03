import { useCallback, useEffect, useState } from "react";
import { useAlbumStore } from "./store/useAlbumStore";
import { notify } from "./store/useToast";
import { pickAlbumFolder, pickPdfSavePath } from "./lib/tauri";
import AlbumGridView from "./views/AlbumGridView";
import PhotoEditorView from "./views/PhotoEditorView";
import PdfExportRunner from "./components/PdfExportRunner";
import ToastHost from "./components/ToastHost";
import "./App.css";

function App() {
  const folderPath = useAlbumStore((s) => s.folderPath);
  const photoFiles = useAlbumStore((s) => s.photoFiles);
  const openFolder = useAlbumStore((s) => s.openFolder);
  const closeAlbum = useAlbumStore((s) => s.closeAlbum);
  const restoreLastAlbum = useAlbumStore((s) => s.restoreLastAlbum);
  const restoringLastAlbum = useAlbumStore((s) => s.restoringLastAlbum);
  const activePhoto = useAlbumStore((s) => s.activePhoto);
  const setActivePhoto = useAlbumStore((s) => s.setActivePhoto);

  const [exportPath, setExportPath] = useState<string | null>(null);

  // 启动时自动恢复上次打开的相册，省掉每次重新选文件夹
  useEffect(() => {
    restoreLastAlbum();
  }, [restoreLastAlbum]);

  const handleImportFolder = useCallback(async () => {
    try {
      const folder = await pickAlbumFolder();
      if (!folder) return;
      await openFolder(folder);
    } catch (err) {
      notify(`打开相册失败：${err}`, "error");
    }
  }, [openFolder]);

  const handleExport = useCallback(async () => {
    try {
      const path = await pickPdfSavePath();
      if (!path) return;
      setExportPath(path);
    } catch (err) {
      notify(`无法选择保存位置：${err}`, "error");
    }
  }, []);

  if (restoringLastAlbum) {
    return (
      <main className="welcome-boot">
        <span className="spinner" />
      </main>
    );
  }

  if (!folderPath) {
    return (
      <main className="welcome-screen">
        <h1 className="welcome-mark">拾光笺</h1>
        <p className="welcome-tagline">标好每一处要改的地方，一份 PDF 交给修图师</p>
        <button className="primary-btn" onClick={handleImportFolder}>
          导入相册文件夹
        </button>
        <ToastHost />
      </main>
    );
  }

  return (
    <main className="app-main">
      {activePhoto ? (
        <PhotoEditorView
          fileName={activePhoto}
          photoFiles={photoFiles}
          onBack={() => setActivePhoto(null)}
          onNavigate={setActivePhoto}
        />
      ) : (
        <AlbumGridView
          onOpenPhoto={setActivePhoto}
          onExport={handleExport}
          onSwitchAlbum={async () => {
            closeAlbum();
            await handleImportFolder();
          }}
        />
      )}

      {exportPath && (
        <PdfExportRunner
          outputPath={exportPath}
          onDone={(error) => {
            setExportPath(null);
            if (error) notify(`导出失败：${error}`, "error");
            else notify("PDF 已导出");
          }}
        />
      )}

      <ToastHost />
    </main>
  );
}

export default App;
