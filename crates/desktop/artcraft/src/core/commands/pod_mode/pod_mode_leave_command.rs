use crate::core::commands::pod_mode::pod_mode_add_storage_origin_command::{Outcome, only_main};
use crate::core::pod_mode::state::PodModeState;
use crate::core::pod_mode::window::rebuild_main_window;
use pod_mode::transition;
use tauri::{AppHandle, Manager, WebviewWindow};

/// Clears pod mode and reopens the window. The window must already have wiped its local pod
/// data; this command cannot check that, so the page's disconnect flow enforces the order
/// (wipe, then ask to leave). Leaving needs no dialog, but it does restore analytics, so a page that skips the wipe leaves pod data behind in an ordinary window; the README states this residual.
#[tauri::command]
pub async fn pod_mode_leave_command(window: WebviewWindow, app: AppHandle) -> Result<Outcome, String> {
  only_main(&window)?;
  let state = app.state::<PodModeState>();
  state.replace(transition::leave()).map_err(|_| "persist_failed".to_string())?;
  rebuild_main_window(&app).await?;
  Ok(Outcome::Applied)
}
