use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 项目级常用清单条目
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    pub text: String,
}

/// 单张照片的批注数据
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoRecord {
    /// 标注图形的原始 JSON，前端负责其结构，后端只做透传存储。
    /// 用数组而不是裸 Value，避免旧数据里的 null 让前端拿到非数组值。
    #[serde(default)]
    pub annotations: Vec<serde_json::Value>,
    #[serde(default)]
    pub checked_item_ids: Vec<String>,
    /// 该照片专属的一次性备注
    #[serde(default)]
    pub note: String,
}

/// 存储在相册文件夹 `.weddingreview/project.json` 里的完整项目数据
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectData {
    #[serde(default)]
    pub checklist_library: Vec<ChecklistItem>,
    /// key 为文件名
    #[serde(default)]
    pub photos: HashMap<String, PhotoRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPayload {
    pub photo_files: Vec<String>,
    pub project: ProjectData,
}
