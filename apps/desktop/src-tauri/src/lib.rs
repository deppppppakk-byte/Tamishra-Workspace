use std::{env, fs, path::PathBuf};

const MAX_STARTUP_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn read_startup_file(extension_name: &str) -> Result<Option<String>, String> {
    let path = env::args()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case(extension_name))
                .unwrap_or(false)
        });

    let Some(path) = path else {
        return Ok(None);
    };

    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect startup .{extension_name}: {error}"))?;

    if metadata.len() > MAX_STARTUP_FILE_BYTES {
        return Err(format!(
            "Startup .{extension_name} exceeds the 64 MB safety limit."
        ));
    }

    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("Could not read startup .{extension_name}: {error}"))
}

#[tauri::command]
fn startup_tmdoc() -> Result<Option<String>, String> {
    read_startup_file("tmdoc")
}

#[tauri::command]
fn startup_tmsh() -> Result<Option<String>, String> {
    read_startup_file("tmsh")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![startup_tmdoc, startup_tmsh])
        .run(tauri::generate_context!())
        .expect("error while running Tamishra Workspace");
}
