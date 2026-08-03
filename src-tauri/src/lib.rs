mod commands;
mod models;
mod pdf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::project::open_album,
            commands::project::save_project,
            commands::project::get_last_album,
            commands::photos::ensure_thumbnails_batch,
            commands::photos::get_image_size,
            commands::photos::get_preview_bytes,
            commands::photos::get_full_bytes,
            commands::photos::warm_previews,
            commands::export::export_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
