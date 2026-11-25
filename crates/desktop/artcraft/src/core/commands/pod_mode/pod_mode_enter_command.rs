use crate::core::commands::pod_mode::pod_mode_add_storage_origin_command::{Outcome, only_main};
use crate::core::pod_mode::confirm::{confirm_blocking, enter_message};
use crate::core::pod_mode::state::PodModeState;
use crate::core::pod_mode::window::rebuild_main_window;
use pod_mode::origin::Loopback;
use pod_mode::transition;
use tauri::{AppHandle, Manager, WebviewWindow};

/// The page asks to enter pod mode for an issuer origin. The app validates it, asks the person
/// in a native dialog that names the origin, persists the record and rebuilds the window.
/// Takes an origin only; never a credential.
#[tauri::command]
pub async fn pod_mode_enter_command(
  window: WebviewWindow,
  app: AppHandle,
  issuer: String,
) -> Result<Outcome, String> {
  only_main(&window)?;
  let record = transition::enter(&issuer, Loopback::for_this_build()).map_err(|_| "invalid_origin".to_string())?;
  let state = app.state::<PodModeState>();
  if !state.try_open_dialog() {
    return Err("busy".into());
  }
  let origin = record.issuer.clone().unwrap_or_default();
  let confirm_app = app.clone();
  let accepted = tauri::async_runtime::spawn_blocking(move || {
    confirm_blocking(&confirm_app, "Enter Solid pod mode", enter_message(&origin), "Enter pod mode")
  })
  .await;
  state.close_dialog();
  if !accepted.map_err(|_| "dialog_failed".to_string())? {
    return Ok(Outcome::Declined);
  }
  state.replace(record).map_err(|_| "persist_failed".to_string())?;
  rebuild_main_window(&app).await?;
  Ok(Outcome::Applied)
}
