import { create } from "zustand";
import { v4 as uuid } from "uuid";
import { emptyPhotoRecord, emptyProjectData, ProjectData, PhotoRecord } from "../types";
import {
  openAlbum,
  saveProject,
  ensureThumbnailsBatch,
  ThumbnailProgress,
  getLastAlbum,
  warmPreviews,
} from "../lib/tauri";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 单张照片的撤销/重做栈 */
interface AnnotationHistory {
  past: unknown[][];
  future: unknown[][];
}

/** 每张照片保留的步数 */
const HISTORY_LIMIT = 40;
/**
 * 最多为多少张照片保留历史。
 * 历史只活在内存里（关掉应用就没了，这是刻意的：撤销是编辑手感，
 * 防丢数据靠的是打开相册时落盘的备份快照）。加这个上限是防止
 * 一次会话翻过几百张之后内存无限增长。
 */
const HISTORY_PHOTO_LIMIT = 40;

interface AlbumState {
  folderPath: string | null;
  photoFiles: string[];
  project: ProjectData;
  activePhoto: string | null;
  thumbnails: Record<string, string>;
  thumbnailProgress: ThumbnailProgress | null;
  restoringLastAlbum: boolean;
  /** 按文件名分桶的撤销历史，翻走再翻回来依然能撤销 */
  histories: Record<string, AnnotationHistory>;

  openFolder: (folderPath: string) => Promise<void>;
  generateThumbnails: () => void;
  closeAlbum: () => void;
  restoreLastAlbum: () => Promise<void>;
  setActivePhoto: (fileName: string | null) => void;

  updatePhotoRecord: (fileName: string, patch: Partial<PhotoRecord>) => void;

  /** 改标注统一走这里，才会进撤销历史 */
  commitAnnotations: (fileName: string, next: unknown[]) => void;
  undoAnnotations: (fileName: string) => boolean;
  redoAnnotations: (fileName: string) => boolean;

  addChecklistItem: (text: string) => void;
  removeChecklistItem: (id: string) => void;

  scheduleSave: () => void;
}

export const useAlbumStore = create<AlbumState>((set, get) => ({
  folderPath: null,
  photoFiles: [],
  project: emptyProjectData(),
  activePhoto: null,
  thumbnails: {},
  thumbnailProgress: null,
  restoringLastAlbum: true,
  histories: {},

  async openFolder(folderPath) {
    // 这一步只做"相册已经可以展示"所需的快速元数据读取（文件列表 + 已保存的批注数据）。
    // 缩略图生成是重活，故意不在这里 await，避免调用方（尤其是启动时自动恢复相册）
    // 被整个缩略图生成过程卡住、导致进度条被"卡在欢迎页"这段时间挡住看不见。
    const payload = await openAlbum(folderPath);
    set({
      folderPath,
      photoFiles: payload.photoFiles,
      project: payload.project,
      activePhoto: null,
      thumbnails: {},
      thumbnailProgress: null,
      histories: {},
    });
    get().generateThumbnails();
  },

  generateThumbnails() {
    const { folderPath, photoFiles } = get();
    if (!folderPath || photoFiles.length === 0) return;
    set({ thumbnailProgress: { done: 0, total: photoFiles.length } });
    ensureThumbnailsBatch(folderPath, photoFiles, (progress) => {
      set({ thumbnailProgress: progress });
    })
      .then((thumbnails) => {
        set({ thumbnails, thumbnailProgress: null });
        // 缩略图铺好后再在后台备预览图，翻页时就不用现场生成了
        warmPreviews(folderPath, photoFiles).catch(() => undefined);
      })
      .catch((err) => {
        console.error("生成缩略图失败", err);
        set({ thumbnailProgress: null });
      });
  },

  closeAlbum() {
    set({
      folderPath: null,
      photoFiles: [],
      project: emptyProjectData(),
      activePhoto: null,
      thumbnails: {},
      thumbnailProgress: null,
      histories: {},
    });
  },

  async restoreLastAlbum() {
    try {
      const last = await getLastAlbum();
      if (last) await get().openFolder(last);
    } catch (err) {
      console.warn("恢复最近打开的相册失败", err);
    } finally {
      set({ restoringLastAlbum: false });
    }
  },

  setActivePhoto(fileName) {
    set({ activePhoto: fileName });
  },

  updatePhotoRecord(fileName, patch) {
    set((state) => ({
      project: {
        ...state.project,
        photos: {
          ...state.project.photos,
          [fileName]: { ...emptyPhotoRecord(), ...state.project.photos[fileName], ...patch },
        },
      },
    }));
    get().scheduleSave();
  },

  commitAnnotations(fileName, next) {
    set((state) => {
      const current = (state.project.photos[fileName]?.annotations ?? []) as unknown[];
      const history = state.histories[fileName] ?? { past: [], future: [] };
      const past = [...history.past, current].slice(-HISTORY_LIMIT);

      const histories = { ...state.histories, [fileName]: { past, future: [] } };
      // 超出上限就丢掉最早建立历史的那些照片（对象键保持插入顺序）
      const keys = Object.keys(histories);
      if (keys.length > HISTORY_PHOTO_LIMIT) {
        for (const stale of keys.slice(0, keys.length - HISTORY_PHOTO_LIMIT)) {
          if (stale !== fileName) delete histories[stale];
        }
      }

      return {
        histories,
        project: {
          ...state.project,
          photos: {
            ...state.project.photos,
            [fileName]: {
              ...emptyPhotoRecord(),
              ...state.project.photos[fileName],
              annotations: next,
            },
          },
        },
      };
    });
    get().scheduleSave();
  },

  undoAnnotations(fileName) {
    const history = get().histories[fileName];
    if (!history || history.past.length === 0) return false;

    set((state) => {
      const h = state.histories[fileName];
      const past = h.past.slice(0, -1);
      const restored = h.past[h.past.length - 1];
      const current = (state.project.photos[fileName]?.annotations ?? []) as unknown[];
      return {
        histories: { ...state.histories, [fileName]: { past, future: [...h.future, current] } },
        project: {
          ...state.project,
          photos: {
            ...state.project.photos,
            [fileName]: {
              ...emptyPhotoRecord(),
              ...state.project.photos[fileName],
              annotations: restored,
            },
          },
        },
      };
    });
    get().scheduleSave();
    return true;
  },

  redoAnnotations(fileName) {
    const history = get().histories[fileName];
    if (!history || history.future.length === 0) return false;

    set((state) => {
      const h = state.histories[fileName];
      const future = h.future.slice(0, -1);
      const restored = h.future[h.future.length - 1];
      const current = (state.project.photos[fileName]?.annotations ?? []) as unknown[];
      return {
        histories: { ...state.histories, [fileName]: { past: [...h.past, current], future } },
        project: {
          ...state.project,
          photos: {
            ...state.project.photos,
            [fileName]: {
              ...emptyPhotoRecord(),
              ...state.project.photos[fileName],
              annotations: restored,
            },
          },
        },
      };
    });
    get().scheduleSave();
    return true;
  },

  addChecklistItem(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((state) => ({
      project: {
        ...state.project,
        checklistLibrary: [...state.project.checklistLibrary, { id: uuid(), text: trimmed }],
      },
    }));
    get().scheduleSave();
  },

  removeChecklistItem(id) {
    set((state) => {
      // 同时把这一项从所有照片的勾选里摘掉，避免留下指向已删条目的悬挂 id
      const photos: ProjectData["photos"] = {};
      for (const [fileName, record] of Object.entries(state.project.photos)) {
        photos[fileName] = record.checkedItemIds.includes(id)
          ? { ...record, checkedItemIds: record.checkedItemIds.filter((i) => i !== id) }
          : record;
      }
      return {
        project: {
          checklistLibrary: state.project.checklistLibrary.filter((item) => item.id !== id),
          photos,
        },
      };
    });
    get().scheduleSave();
  },

  scheduleSave() {
    if (!get().folderPath) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // 必须在回调里重新取最新状态：防抖期内的多次修改否则会被第一次的快照覆盖掉
      const { folderPath, project } = get();
      if (!folderPath) return;
      saveProject(folderPath, project).catch((err) => {
        console.error("保存项目数据失败", err);
      });
    }, 500);
  },
}));
