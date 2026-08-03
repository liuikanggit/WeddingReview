// 与 src-tauri/src/models.rs 保持一致

export interface ChecklistItem {
  id: string;
  text: string;
}

export interface PhotoRecord {
  annotations: unknown[];
  checkedItemIds: string[];
  note: string;
}

export interface ProjectData {
  checklistLibrary: ChecklistItem[];
  photos: Record<string, PhotoRecord>;
}

export interface AlbumPayload {
  photoFiles: string[];
  project: ProjectData;
}

export function emptyPhotoRecord(): PhotoRecord {
  return { annotations: [], checkedItemIds: [], note: "" };
}

export function emptyProjectData(): ProjectData {
  return { checklistLibrary: [], photos: {} };
}
