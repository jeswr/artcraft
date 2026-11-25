use crate::core::pod_mode::state::PodModeState;
use crate::core::windows::main_window::constants::MAIN_WINDOW_NAME;
use tauri::{AppHandle, Manager};

/// Closes the main window and opens a fresh one, so the initialization script and the response
/// header both reflect the record. The app cannot exit in between.
pub async fn rebuild_main_window(app: &AppHandle) -> Result<(), String> {
  let state = app.state::<PodModeState>();
  state.set_rebuilding(true);
  let result = rebuild(app).await;
  state.set_rebuilding(false);
  result
}

async fn rebuild(app: &AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_NAME) {
    window.destroy().map_err(|_| "window_close_failed".to_string())?;
  }
  crate::core::lifecycle::startup::setup_main_window::setup_main_window(app)
    .await
    .map_err(|_| "window_open_failed".to_string())
}
