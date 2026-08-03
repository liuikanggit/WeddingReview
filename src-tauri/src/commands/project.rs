use crate::models::{AlbumPayload, ProjectData};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const IMAGE_EXTS: [&str; 6] = ["jpg", "jpeg", "png", "heic", "heif", "webp"];

fn data_dir(folder: &Path) -> PathBuf {
    folder.join(".weddingreview")
}

fn project_json_path(folder: &Path) -> PathBuf {
    data_dir(folder).join("project.json")
}

fn backup_dir(folder: &Path) -> PathBuf {
    data_dir(folder).join("backups")
}

/// 保留的历史备份份数
const MAX_BACKUPS: usize = 8;

/// 已有的备份文件，按文件名（含时间戳）升序，最旧的在前
fn existing_backups(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("project-"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    files
}

/**
 * 每次打开相册时给现有批注留一份快照。
 *
 * 这是"数据安全"手段，和撤销历史是两回事：撤销管的是编辑手感、关掉就没了；
 * 快照要兜住的是"整份批注被误清空/写坏"这类事故，必须落盘。
 * 内容和最新一份完全相同就跳过，避免反复开关应用把有用的旧备份冲掉。
 */
fn backup_project(folder: &Path) -> Result<(), String> {
    let src = project_json_path(folder);
    if !src.exists() {
        return Ok(());
    }
    let content = fs::read(&src).map_err(|e| format!("读取项目数据失败: {e}"))?;

    let dir = backup_dir(folder);
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let mut backups = existing_backups(&dir);
    if let Some(latest) = backups.last() {
        if fs::read(latest).map(|prev| prev == content).unwrap_or(false) {
            return Ok(());
        }
    }

    let stamp = jiff::Zoned::now().strftime("%Y%m%d-%H%M%S").to_string();
    fs::write(dir.join(format!("project-{stamp}.json")), &content)
        .map_err(|e| format!("写入备份失败: {e}"))?;

    // 只保留最近若干份
    while backups.len() + 1 > MAX_BACKUPS {
        let oldest = backups.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

fn last_album_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位应用配置目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用配置目录失败: {e}"))?;
    Ok(dir.join("last_album.json"))
}

/// 读取上次成功打开的相册文件夹路径，供启动时自动恢复，不用每次都重新手动选择
#[tauri::command]
pub fn get_last_album(app: AppHandle) -> Result<Option<String>, String> {
    let path = last_album_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取最近相册记录失败: {e}"))?;
    #[derive(serde::Deserialize)]
    struct LastAlbum {
        folder_path: String,
    }
    let parsed: LastAlbum =
        serde_json::from_str(&raw).map_err(|e| format!("最近相册记录解析失败: {e}"))?;
    Ok(Some(parsed.folder_path))
}

/// 导入相册文件夹：扫描图片文件列表，并读取已存在的 project.json（若有），
/// 同时记住这个路径，下次启动自动恢复
#[tauri::command]
pub fn open_album(app: AppHandle, folder_path: String) -> Result<AlbumPayload, String> {
    let folder = Path::new(&folder_path);

    let mut photo_files: Vec<String> = fs::read_dir(folder)
        .map_err(|e| format!("读取文件夹失败: {e}"))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let ext = Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            IMAGE_EXTS.contains(&ext.as_str()).then_some(name)
        })
        .collect();
    photo_files.sort();

    let json_path = project_json_path(folder);
    let project = if json_path.exists() {
        let raw = fs::read_to_string(&json_path).map_err(|e| format!("读取项目数据失败: {e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("项目数据解析失败: {e}"))?
    } else {
        ProjectData::default()
    };

    // 打开即快照：备份失败不该挡住正常打开相册
    if let Err(err) = backup_project(folder) {
        eprintln!("备份项目数据失败: {err}");
    }

    if let Ok(last_path) = last_album_path(&app) {
        let raw = serde_json::json!({ "folder_path": folder_path }).to_string();
        let _ = fs::write(last_path, raw);
    }

    Ok(AlbumPayload {
        photo_files,
        project,
    })
}

/// 保存项目数据（标注、清单库、勾选状态、备注）到相册目录下的 sidecar 文件
#[tauri::command]
pub fn save_project(folder_path: String, project: ProjectData) -> Result<(), String> {
    let folder = Path::new(&folder_path);
    let dir = data_dir(folder);
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let raw = serde_json::to_string_pretty(&project).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(project_json_path(folder), raw).map_err(|e| format!("写入项目数据失败: {e}"))?;
    Ok(())
}
