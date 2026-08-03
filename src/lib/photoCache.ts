import { getFullUrl, getImageSize, getPreviewUrl } from "./tauri";

export interface PhotoPreview {
  /** blob: URL */
  src: string;
  /** 原图像素尺寸（不是预览图的尺寸），导出分辨率决策依据 */
  width: number;
  height: number;
}

/**
 * 照片分两级：
 * · 预览图（最长边 2000px）——翻页时用它，秒开；
 * · 原图——只有当用户放大到超过 100% 时才按需取，翻页不会触发。
 *
 * 两级都以 blob: URL 形式缓存，被 LRU 淘汰时必须 revoke，否则内存不会释放。
 * 画布里的 1400px「基准坐标系」只是标注坐标的单位，不限制画质：
 * Konva 按图源采样绘制，图源换成原图，放大就是清晰的。
 */
const MAX_PREVIEWS = 10;
/** 原图很占内存，只留当前这张和上一张 */
const MAX_FULLS = 2;

/** 与 Rust 端 PREVIEW_MAX_DIM 保持一致，用于判断预览图何时不够清晰 */
export const PREVIEW_MAX_DIM = 2000;

function makeUrlCache(limit: number) {
  const map = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();

  function touch(key: string, url: string) {
    map.delete(key);
    map.set(key, url);
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      const staleUrl = map.get(oldest);
      map.delete(oldest);
      if (staleUrl) URL.revokeObjectURL(staleUrl);
    }
  }

  return {
    peek: (key: string) => {
      const hit = map.get(key);
      if (hit) touch(key, hit);
      return hit;
    },
    has: (key: string) => map.has(key) || inflight.has(key),
    load: (key: string, loader: () => Promise<string>) => {
      const hit = map.get(key);
      if (hit) {
        touch(key, hit);
        return Promise.resolve(hit);
      }
      const pending = inflight.get(key);
      if (pending) return pending;

      const task = loader().then((url) => {
        // 并发下若已有同 key 结果，丢弃这次多余的 blob，避免泄漏
        const existing = map.get(key);
        if (existing) {
          URL.revokeObjectURL(url);
          return existing;
        }
        touch(key, url);
        return url;
      });
      inflight.set(key, task);
      task.catch(() => undefined).finally(() => inflight.delete(key));
      return task;
    },
    clear: () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
      inflight.clear();
    },
  };
}

const previewUrls = makeUrlCache(MAX_PREVIEWS);
const fullUrls = makeUrlCache(MAX_FULLS);
/** 原图尺寸很小，单独存一份不设上限 */
const sizes = new Map<string, { width: number; height: number }>();

function keyOf(folderPath: string, fileName: string) {
  return `${folderPath} ${fileName}`;
}

export function peekPreview(folderPath: string, fileName: string): PhotoPreview | undefined {
  const key = keyOf(folderPath, fileName);
  const src = previewUrls.peek(key);
  const size = sizes.get(key);
  return src && size ? { src, ...size } : undefined;
}

export async function loadPreview(folderPath: string, fileName: string): Promise<PhotoPreview> {
  const key = keyOf(folderPath, fileName);
  const [src, size] = await Promise.all([
    previewUrls.load(key, () => getPreviewUrl(folderPath, fileName)),
    sizes.get(key) ??
      getImageSize(folderPath, fileName).then(([width, height]) => {
        const value = { width, height };
        sizes.set(key, value);
        return value;
      }),
  ]);
  return { src, ...size };
}

export function peekFull(folderPath: string, fileName: string) {
  return fullUrls.peek(keyOf(folderPath, fileName));
}

export function loadFull(folderPath: string, fileName: string) {
  return fullUrls.load(keyOf(folderPath, fileName), () => getFullUrl(folderPath, fileName));
}

/** 后台预取相邻照片的预览图，失败静默——预取本来就是尽力而为 */
export function prefetchPreviews(folderPath: string, fileNames: string[]) {
  for (const fileName of fileNames) {
    if (previewUrls.has(keyOf(folderPath, fileName))) continue;
    loadPreview(folderPath, fileName).catch(() => undefined);
  }
}

/** 取当前照片前后各若干张的文件名，用于预取 */
export function neighborsOf(photoFiles: string[], fileName: string, radius = 2): string[] {
  const index = photoFiles.indexOf(fileName);
  if (index === -1) return [];
  const result: string[] = [];
  for (let offset = 1; offset <= radius; offset++) {
    // 先后一张再前一张：向后翻页更常见
    if (index + offset < photoFiles.length) result.push(photoFiles[index + offset]);
    if (index - offset >= 0) result.push(photoFiles[index - offset]);
  }
  return result;
}

export function clearPhotoCache() {
  previewUrls.clear();
  fullUrls.clear();
  sizes.clear();
}
