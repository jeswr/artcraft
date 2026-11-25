use crate::core::commands::pod_mode::pod_mode_add_storage_origin_command::{Outcome, only_main};
use crate::core::pod_mode::window::rebuild_main_window;
use tauri::{AppHandle, WebviewWindow};

/// Rebuilds the main window in the mode it is already in. The page asks for this to drop its
/// open storage connections so a queued delete of its sign-in data can finish. It changes no
/// record and takes no input.
#[tauri::command]
pub async fn pod_mode_reload_command(window: WebviewWindow, app: AppHandle) -> Result<Outcome, String> {
  only_main(&window)?;
  rebuild_main_window(&app).await?;
  Ok(Outcome::Applied)
}
