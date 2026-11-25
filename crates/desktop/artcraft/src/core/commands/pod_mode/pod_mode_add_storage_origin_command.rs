use crate::core::pod_mode::confirm::{add_storage_message, confirm_blocking};
use crate::core::pod_mode::state::PodModeState;
use crate::core::pod_mode::window::rebuild_main_window;
use crate::core::windows::main_window::constants::MAIN_WINDOW_NAME;
use pod_mode::origin::Loopback;
use pod_mode::transition;
use serde_derive::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
  Applied,
  Declined,
}

/// Pod-mode commands answer only the main window.
pub fn only_main(window: &WebviewWindow) -> Result<(), String> {
  if window.label() == MAIN_WINDOW_NAME { Ok(()) } else { Err("forbidden".to_string()) }
}

/// The page asks to let pod mode contact a storage origin. Same pattern as entering: validate,
/// confirm natively with the origin named, persist, rebuild. Origins only.
#[tauri::command]
pub async fn pod_mode_add_storage_origin_command(
  window: WebviewWindow,
  app: AppHandle,
  origin: String,
) -> Result<Outcome, String> {
  only_main(&window)?;
  let state = app.state::<PodModeState>();
  let next = transition::add_storage_origin(&state.record(), &origin, Loopback::for_this_build())
    .map_err(|e| match e {
      transition::TransitionError::NotInPodMode => "not_in_pod_mode",
      transition::TransitionError::TooManyStorageOrigins => "too_many_origins",
      transition::TransitionError::InvalidOrigin => "invalid_origin",
    }.to_string())?;
  if next == state.record() {
    return Ok(Outcome::Applied);
  }
  if !state.try_open_dialog() {
    return Err("busy".into());
  }
  let shown = origin.clone();
  let confirm_app = app.clone();
  let accepted = tauri::async_runtime::spawn_blocking(move || {
    confirm_blocking(&confirm_app, "Allow a Solid storage server", add_storage_message(&shown), "Allow")
  })
  .await;
  state.close_dialog();
  if !accepted.map_err(|_| "dialog_failed".to_string())? {
    return Ok(Outcome::Declined);
  }
  state.replace(next).map_err(|_| "persist_failed".to_string())?;
  rebuild_main_window(&app).await?;
  Ok(Outcome::Applied)
}
