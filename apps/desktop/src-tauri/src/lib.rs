use serde::Serialize;
use std::{
    env,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct NativeFileState {
    current_path: Mutex<Option<PathBuf>>,
    pending_path: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeTmslFile {
    path: String,
    name: String,
    bytes: Vec<u8>,
}

fn is_tmsl(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("tmsl"))
        .unwrap_or(false)
}

const MAX_SIMPLE_NATIVE_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn startup_text_file(extension_name: &str) -> Result<Option<String>, String> {
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

    if metadata.len() > MAX_SIMPLE_NATIVE_FILE_BYTES {
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
    startup_text_file("tmdoc")
}

#[tauri::command]
fn startup_tmsh() -> Result<Option<String>, String> {
    startup_text_file("tmsh")
}

#[tauri::command]
fn startup_tmnt() -> Result<Option<String>, String> {
    startup_text_file("tmnt")
}

fn normalize_candidate(path: PathBuf) -> Option<PathBuf> {
    if !is_tmsl(&path) {
        return None;
    }

    Some(path.canonicalize().unwrap_or(path))
}

fn tmsl_from_args(args: &[String], cwd: Option<&str>) -> Option<PathBuf> {
    args.iter().find_map(|argument| {
        if argument.starts_with('-') {
            return None;
        }

        let raw = PathBuf::from(argument);
        let candidate = if raw.is_absolute() {
            raw
        } else if let Some(cwd) = cwd {
            PathBuf::from(cwd).join(raw)
        } else {
            raw
        };

        normalize_candidate(candidate)
    })
}

fn read_tmsl(path: &Path) -> Result<NativeTmslFile, String> {
    if !is_tmsl(path) {
        return Err("Only .tmsl presentations can be opened by this bridge.".into());
    }

    let bytes = fs::read(path).map_err(|error| format!("Unable to read TMSL file: {error}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("presentation.tmsl")
        .to_string();

    Ok(NativeTmslFile {
        path: path.to_string_lossy().into_owned(),
        name,
        bytes,
    })
}

fn set_current_path(state: &NativeFileState, path: PathBuf) -> Result<(), String> {
    let mut current = state
        .current_path
        .lock()
        .map_err(|_| "Native file state is unavailable.".to_string())?;
    *current = Some(path);
    Ok(())
}

fn ensure_tmsl_extension(mut path: PathBuf) -> PathBuf {
    if !is_tmsl(&path) {
        path.set_extension("tmsl");
    }
    path
}

fn write_tmsl(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !is_tmsl(path) {
        return Err("Tamishra Slides native files must use the .tmsl extension.".into());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create presentation folder: {error}"))?;
    }

    fs::write(path, bytes).map_err(|error| format!("Unable to save TMSL file: {error}"))
}

#[tauri::command]
fn take_pending_tmsl(state: State<'_, NativeFileState>) -> Result<Option<NativeTmslFile>, String> {
    let pending = {
        let mut pending = state
            .pending_path
            .lock()
            .map_err(|_| "Native file state is unavailable.".to_string())?;
        pending.take()
    };

    let Some(path) = pending else {
        return Ok(None);
    };

    let file = read_tmsl(&path)?;
    set_current_path(&state, path)?;
    Ok(Some(file))
}

#[tauri::command]
fn open_tmsl_path(
    path: String,
    state: State<'_, NativeFileState>,
) -> Result<NativeTmslFile, String> {
    let path = normalize_candidate(PathBuf::from(path))
        .ok_or_else(|| "The selected file is not a .tmsl presentation.".to_string())?;
    let file = read_tmsl(&path)?;
    set_current_path(&state, path)?;
    Ok(file)
}

#[tauri::command]
fn current_tmsl_path(state: State<'_, NativeFileState>) -> Result<Option<String>, String> {
    let current = state
        .current_path
        .lock()
        .map_err(|_| "Native file state is unavailable.".to_string())?;

    Ok(current
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn save_tmsl_current(
    bytes: Vec<u8>,
    state: State<'_, NativeFileState>,
) -> Result<String, String> {
    let path = {
        let current = state
            .current_path
            .lock()
            .map_err(|_| "Native file state is unavailable.".to_string())?;
        current
            .clone()
            .ok_or_else(|| "No native TMSL file is currently attached.".to_string())?
    };

    write_tmsl(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(desktop)]
#[tauri::command]
fn save_tmsl_as(
    app: AppHandle,
    bytes: Vec<u8>,
    suggested_name: String,
    state: State<'_, NativeFileState>,
) -> Result<Option<String>, String> {
    let file_name = if suggested_name.to_ascii_lowercase().ends_with(".tmsl") {
        suggested_name
    } else {
        format!("{suggested_name}.tmsl")
    };

    let selected = app
        .dialog()
        .file()
        .set_title("Save Tamishra Slides Presentation")
        .set_file_name(file_name)
        .add_filter("Tamishra Slides", &["tmsl"])
        .blocking_save_file();

    let Some(selected) = selected else {
        return Ok(None);
    };

    let path = ensure_tmsl_extension(
        selected
            .into_path()
            .map_err(|error| format!("Unable to resolve selected save path: {error}"))?,
    );

    write_tmsl(&path, &bytes)?;
    set_current_path(&state, path.clone())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn write_tmsl_recovery(app: AppHandle, bytes: Vec<u8>) -> Result<String, String> {
    let mut directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve recovery directory: {error}"))?;
    directory.push("recovery");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create recovery directory: {error}"))?;

    let path = directory.join("slides-recovery.tmsl");
    write_tmsl(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_tmsl_recovery(app: AppHandle) -> Result<Option<NativeTmslFile>, String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve recovery directory: {error}"))?;
    path.push("recovery");
    path.push("slides-recovery.tmsl");

    if !path.exists() {
        return Ok(None);
    }

    read_tmsl(&path).map(Some)
}

#[tauri::command]
fn clear_tmsl_recovery(app: AppHandle) -> Result<(), String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve recovery directory: {error}"))?;
    path.push("recovery");
    path.push("slides-recovery.tmsl");

    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Unable to clear recovery file: {error}"))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_args: Vec<String> = std::env::args().skip(1).collect();
    let initial_tmsl = tmsl_from_args(&initial_args, None);

    let state = NativeFileState {
        current_path: Mutex::new(None),
        pending_path: Mutex::new(initial_tmsl),
    };

    let mut builder = tauri::Builder::default().manage(state);

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
                if let Some(path) = tmsl_from_args(&args, Some(&cwd)) {
                    if let Ok(mut pending) = app.state::<NativeFileState>().pending_path.lock() {
                        *pending = Some(path.clone());
                    }

                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }

                    let _ = app.emit(
                        "tamishra://open-tmsl",
                        path.to_string_lossy().into_owned(),
                    );
                }
            }))
            .plugin(tauri_plugin_dialog::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            take_pending_tmsl,
            startup_tmdoc,
            startup_tmsh,
            startup_tmnt,
            open_tmsl_path,
            current_tmsl_path,
            save_tmsl_current,
            write_tmsl_recovery,
            read_tmsl_recovery,
            clear_tmsl_recovery,
            #[cfg(desktop)]
            save_tmsl_as
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tamishra Workspace");
}
