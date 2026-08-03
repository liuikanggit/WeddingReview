use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::imageops::FilterType;
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter};

const THUMB_MAX_DIM: u32 = 480;
/// 编辑器显示最多用到视口分辨率、导出也只要 1800px，
/// 所以传给前端的是 2000px 的预览图而不是原图——原图一张十几 MB，
/// 编码成 base64 再传过去、再解码，是切换照片卡顿的主因。
const PREVIEW_MAX_DIM: u32 = 2000;

fn thumb_dir(folder: &Path) -> PathBuf {
    folder.join(".weddingreview").join("thumbnails")
}

fn preview_dir(folder: &Path) -> PathBuf {
    folder.join(".weddingreview").join("previews")
}

/// 文件名只应来自 open_album 返回的列表，这里仅做基本校验防止路径穿越
fn ensure_safe_file_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty() || file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("非法文件名".into());
    }
    Ok(())
}

fn to_data_url(bytes: &[u8], mime: &str) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// 生成（如已缓存则直接读取）缩略图字节，固定输出 jpeg 格式
fn thumbnail_bytes(folder: &Path, file_name: &str) -> Result<Vec<u8>, String> {
    let thumb_path = thumb_dir(folder).join(format!("{file_name}.jpg"));

    if !thumb_path.exists() {
        let original = folder.join(file_name);
        let img = image::open(&original).map_err(|e| format!("打开图片 {file_name} 失败: {e}"))?;
        let thumb = img.resize(THUMB_MAX_DIM, THUMB_MAX_DIM, FilterType::Triangle);
        thumb
            .to_rgb8()
            .save(&thumb_path)
            .map_err(|e| format!("保存缩略图 {file_name} 失败: {e}"))?;
    }

    std::fs::read(&thumb_path).map_err(|e| format!("读取缩略图 {file_name} 失败: {e}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbEntry {
    pub file_name: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailProgress {
    done: usize,
    total: usize,
}

/// 缩略图生成是纯 CPU 解码大图的重活。如果直接用 rayon 默认的"每核一个线程"，
/// 会把用户电脑所有核心一次性打满，这台机器本身后台常驻的进程就不少，
/// 全核占满会导致整个系统（包括 WebView 主线程）明显卡顿甚至转圈。
/// 这里故意只用一半核心（至少 2、最多 4 个线程），把这次一次性的批量生成拆得更细水长流，
/// 换来的是不再让整机卡顿。
fn thumbnail_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let threads = (cores / 2).clamp(2, 4);
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("创建缩略图生成线程池失败")
    })
}

/// 并行（但限制线程数）生成一批缩略图，直接把图片数据编码成 data URL 返回给前端，
/// 不再依赖自定义资源协议去读取本地文件——某些真实相册路径下资源协议会莫名加载失败，
/// 直接传数据是最不容易出问题的方式。每完成一张就通过事件汇报进度，供前端展示进度条。
#[tauri::command]
pub fn ensure_thumbnails_batch(
    app: AppHandle,
    folder_path: String,
    file_names: Vec<String>,
) -> Result<Vec<ThumbEntry>, String> {
    let folder = Path::new(&folder_path);
    std::fs::create_dir_all(thumb_dir(folder)).map_err(|e| format!("创建缩略图目录失败: {e}"))?;

    let total = file_names.len();
    let done = AtomicUsize::new(0);

    // 注意：这里故意不让单张图片失败拖垮整批——哪怕某一张损坏/解码失败，
    // 其余能生成的缩略图也要正常返回给前端，只是跳过失败的那一张。
    let entries: Vec<ThumbEntry> = thumbnail_pool().install(|| {
        file_names
            .par_iter()
            .filter_map(|file_name| {
                let result = ensure_safe_file_name(file_name)
                    .and_then(|_| thumbnail_bytes(folder, file_name))
                    .map(|bytes| ThumbEntry {
                        file_name: file_name.clone(),
                        data_url: to_data_url(&bytes, "image/jpeg"),
                    });

                let done_count = done.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit(
                    "thumbnail-progress",
                    ThumbnailProgress {
                        done: done_count,
                        total,
                    },
                );

                match result {
                    Ok(entry) => Some(entry),
                    Err(err) => {
                        eprintln!("缩略图生成跳过 {file_name}: {err}");
                        None
                    }
                }
            })
            .collect()
    });

    Ok(entries)
}

/// 读取原图像素尺寸（宽, 高），前端据此计算标注画布导出的 pixelRatio
#[tauri::command]
pub fn get_image_size(folder_path: String, file_name: String) -> Result<(u32, u32), String> {
    ensure_safe_file_name(&file_name)?;
    let path = Path::new(&folder_path).join(&file_name);
    image::image_dimensions(&path).map_err(|e| format!("读取图片尺寸失败: {e}"))
}

/// 生成（或复用磁盘缓存的）预览图字节
fn preview_bytes(folder: &Path, file_name: &str) -> Result<Vec<u8>, String> {
    let original = folder.join(file_name);
    let (width, height) =
        image::image_dimensions(&original).map_err(|e| format!("读取图片尺寸失败: {e}"))?;

    // 原图本来就不大就不必再压一道
    if width <= PREVIEW_MAX_DIM && height <= PREVIEW_MAX_DIM {
        return std::fs::read(&original).map_err(|e| format!("读取原图 {file_name} 失败: {e}"));
    }

    let dir = preview_dir(folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建预览图目录失败: {e}"))?;
    let preview_path = dir.join(format!("{file_name}.jpg"));

    if !preview_path.exists() {
        let img = image::open(&original).map_err(|e| format!("打开图片 {file_name} 失败: {e}"))?;
        let preview = img.resize(PREVIEW_MAX_DIM, PREVIEW_MAX_DIM, FilterType::Triangle);
        preview
            .to_rgb8()
            .save(&preview_path)
            .map_err(|e| format!("保存预览图 {file_name} 失败: {e}"))?;
    }

    std::fs::read(&preview_path).map_err(|e| format!("读取预览图 {file_name} 失败: {e}"))
}

/**
 * 图片一律以二进制回传，不走 base64。
 *
 * 之前用 data URL 传图会让整个界面卡死：十几 MB 的图编码成 base64 后是个几千万字符的
 * 字符串，IPC 那头解析这个字符串是同步的，直接把 WebView 主线程堵住。
 * 二进制走 Raw 通道，前端拿到 ArrayBuffer 直接包成 Blob，全程不碰巨型字符串。
 */
#[tauri::command]
pub fn get_preview_bytes(folder_path: String, file_name: String) -> Result<Response, String> {
    ensure_safe_file_name(&file_name)?;
    let bytes = preview_bytes(Path::new(&folder_path), &file_name)?;
    Ok(Response::new(bytes))
}

/// 原图字节。只在用户放大到需要看真实像素时才调用，翻页不会触发。
#[tauri::command]
pub fn get_full_bytes(folder_path: String, file_name: String) -> Result<Response, String> {
    ensure_safe_file_name(&file_name)?;
    let path = Path::new(&folder_path).join(&file_name);
    let bytes = std::fs::read(&path).map_err(|e| format!("读取原图 {file_name} 失败: {e}"))?;
    Ok(Response::new(bytes))
}

/// 打开相册后在后台把预览图都备好，之后翻页只是读一个几百 KB 的小文件。
/// 不返回图片数据，只负责把磁盘缓存填上；用与缩略图相同的限流线程池，不抢满 CPU。
#[tauri::command]
pub fn warm_previews(folder_path: String, file_names: Vec<String>) {
    std::thread::spawn(move || {
        let folder = Path::new(&folder_path);
        thumbnail_pool().install(|| {
            file_names.par_iter().for_each(|file_name| {
                if ensure_safe_file_name(file_name).is_err() {
                    return;
                }
                if let Err(err) = preview_bytes(folder, file_name) {
                    eprintln!("预览图预生成跳过 {file_name}: {err}");
                }
            });
        });
    });
}
