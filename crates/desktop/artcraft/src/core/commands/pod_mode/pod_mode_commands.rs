//! The page's way to ask for a change of pod mode. Each command is a thin call into the
//! `pod_mode` controller, which holds the logic and is tested without a webview. Commands take
//! an origin at most, never a credential, and answer only the main window.

use crate::core::pod_mode::PodModeController;
use pod_mode::controller::{CommandError, Reply};
use serde_derive::Serialize;
use tauri::{State, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
  Applied,
  Declined,
  /// Allow was pressed too fast to be a considered answer; nothing changed.
  TooFast,
}

fn outcome(result: Result<Reply, CommandError>) -> Result<Outcome, String> {
  match result {
    Ok(Reply::Applied) => Ok(Outcome::Applied),
    Ok(Reply::Declined) => Ok(Outcome::Declined),
    Ok(Reply::TooFast) => Ok(Outcome::TooFast),
    Err(e) => Err(e.as_str().to_string()),
  }
}

#[tauri::command]
pub async fn pod_mode_enter_command(
  window: WebviewWindow,
  controller: State<'_, PodModeController>,
  issuer: String,
) -> Result<Outcome, String> {
  outcome(controller.enter(window.label(), &issuer).await)
}

#[tauri::command]
pub async fn pod_mode_add_storage_origin_command(
  window: WebviewWindow,
  controller: State<'_, PodModeController>,
  origin: String,
) -> Result<Outcome, String> {
  outcome(controller.add_storage_origin(window.label(), &origin).await)
}

/// The window asks to leave only after its own wipe reported success. The app cannot check that.
#[tauri::command]
pub async fn pod_mode_leave_command(
  window: WebviewWindow,
  controller: State<'_, PodModeController>,
) -> Result<Outcome, String> {
  outcome(controller.leave(window.label()).await)
}

/// A wipe succeeded in a window that is not in pod mode.
#[tauri::command]
pub async fn pod_mode_credentials_cleared_command(
  window: WebviewWindow,
  controller: State<'_, PodModeController>,
) -> Result<Outcome, String> {
  outcome(controller.credentials_cleared(window.label()).await)
}

#[tauri::command]
pub async fn pod_mode_reload_command(
  window: WebviewWindow,
  controller: State<'_, PodModeController>,
) -> Result<Outcome, String> {
  outcome(controller.reload(window.label()).await)
}

/// The click that starts a fresh sign-in: returns the issuer the person approved in this
/// process, once.
#[tauri::command]
pub async fn pod_mode_consume_fresh_command(
  window: WebviewWindow,
  controller: State<'_, PodModeController>,
) -> Result<String, String> {
  controller.consume_fresh(window.label()).await.map_err(|e| e.as_str().to_string())
}
