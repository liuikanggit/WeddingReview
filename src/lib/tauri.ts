import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AlbumPayload, ProjectData } from "../types";

export async function pickAlbumFolder(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title: "选择相册文件夹" });
  return typeof result === "string" ? result : null;
}

export async function openAlbum(folderPath: string): Promise<AlbumPayload> {
  return invoke<AlbumPayload>("open_album", { folderPath });
}

/** 读取上次成功打开的相册路径，用于启动时自动恢复，不用每次都重新手动导入 */
export async function getLastAlbum(): Promise<string | null> {
  return invoke<string | null>("get_last_album");
}

export async function saveProject(folderPath: string, project: ProjectData): Promise<void> {
  return invoke("save_project", { folderPath, project });
}

export interface ThumbnailProgress {
  done: number;
  total: number;
}

/**
 * 多线程并行批量生成缩略图，直接拿到 data URL（不走自定义资源协议——
 * 部分真实相册路径下资源协议会在 WebView 层莫名加载失败，直接传数据最稳）。
 * onProgress 在每完成一张时回调。
 */
export async function ensureThumbnailsBatch(
  folderPath: string,
  fileNames: string[],
  onProgress?: (progress: ThumbnailProgress) => void,
): Promise<Record<string, string>> {
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<ThumbnailProgress>("thumbnail-progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    const entries = await invoke<{ fileName: string; dataUrl: string }[]>(
      "ensure_thumbnails_batch",
      { folderPath, fileNames },
    );
    const map: Record<string, string> = {};
    for (const entry of entries) {
      map[entry.fileName] = entry.dataUrl;
    }
    return map;
  } finally {
    unlisten?.();
  }
}

/**
 * 图片走二进制 IPC 而非 data URL。
 * base64 会把一张十几 MB 的照片变成几千万字符的字符串，前端解析它是同步的，
 * 会把整个界面卡住；拿 ArrayBuffer 包成 Blob 则全程不经过巨型字符串。
 */
async function fetchImageAsBlobUrl(
  command: string,
  folderPath: string,
  fileName: string,
): Promise<string> {
  const bytes = await invoke<ArrayBuffer | number[]>(command, { folderPath, fileName });
  const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
  return URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
}

/** 2000px 预览图（Rust 侧磁盘缓存），返回 blob: URL */
export function getPreviewUrl(folderPath: string, fileName: string): Promise<string> {
  return fetchImageAsBlobUrl("get_preview_bytes", folderPath, fileName);
}

/** 原图，返回 blob: URL。只在需要看真实像素时调用 */
export function getFullUrl(folderPath: string, fileName: string): Promise<string> {
  return fetchImageAsBlobUrl("get_full_bytes", folderPath, fileName);
}

/** 让后端在后台把整册的预览图备好，翻页时就只是读小文件了 */
export function warmPreviews(folderPath: string, fileNames: string[]): Promise<void> {
  return invoke("warm_previews", { folderPath, fileNames });
}

export async function getImageSize(
  folderPath: string,
  fileName: string,
): Promise<[number, number]> {
  return invoke<[number, number]>("get_image_size", { folderPath, fileName });
}

export interface PhotoExportInput {
  fileName: string;
  compositeImageBase64: string;
  checklistLines: string[];
  note: string;
}

export async function pickPdfSavePath(): Promise<string | null> {
  const result = await save({
    title: "导出修图批注 PDF",
    defaultPath: "修图批注.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return result ?? null;
}

export async function exportPdf(
  outputPath: string,
  photos: PhotoExportInput[],
): Promise<void> {
  return invoke("export_pdf", { outputPath, photos });
}
