use crate::pdf::{build_pdf, PhotoPage};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use std::fs;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoExportInput {
    pub file_name: String,
    /// Konva 导出的合成图，带 `data:image/...;base64,` 前缀
    pub composite_image_base64: String,
    pub checklist_lines: Vec<String>,
    pub note: String,
}

fn strip_data_url_prefix(s: &str) -> &str {
    s.split_once(',').map(|(_, data)| data).unwrap_or(s)
}

/// 把每张照片的合成图 + 清单文字拼成一份 PDF，写到 output_path
#[tauri::command]
pub fn export_pdf(output_path: String, photos: Vec<PhotoExportInput>) -> Result<(), String> {
    let mut pages = Vec::with_capacity(photos.len());
    for photo in photos {
        let image_bytes = STANDARD
            .decode(strip_data_url_prefix(&photo.composite_image_base64))
            .map_err(|e| format!("解码照片 {} 失败: {e}", photo.file_name))?;
        pages.push(PhotoPage {
            file_name: photo.file_name,
            composite_image: image_bytes,
            checklist_lines: photo.checklist_lines,
            note: photo.note,
        });
    }

    let pdf_bytes = build_pdf(pages)?;
    fs::write(&output_path, pdf_bytes).map_err(|e| format!("写入 PDF 失败: {e}"))?;
    Ok(())
}
