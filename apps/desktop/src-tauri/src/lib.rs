use std::{env, fs, path::PathBuf};

const MAX_STARTUP_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
fn startup_tmdoc() -> Result<Option<String>, String> {
    let path = env::args()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("tmdoc"))
                .unwrap_or(false)
        });

    let Some(path) = path else {
        return Ok(None);
    };

    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect startup .tmdoc: {error}"))?;

    if metadata.len() > MAX_STARTUP_DOCUMENT_BYTES {
        return Err("Startup .tmdoc exceeds the 64 MB safety limit.".to_string());
    }

    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("Could not read startup .tmdoc: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![startup_tmdoc])
        .run(tauri::generate_context!())
        .expect("error while running Tamishra Workspace");
}
