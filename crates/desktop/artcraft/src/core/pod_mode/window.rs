use crate::core::pod_mode::state::PodModeState;
use crate::core::windows::main_window::constants::MAIN_WINDOW_NAME;
use pod_mode::controller::Windows;
use pod_mode::rebuild::{Surface, rebuild_main};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The Tauri side of the window sequence in `pod_mode::rebuild`.
pub struct TauriSurface {
  app: AppHandle,
}

impl Surface for TauriSurface {
  fn guard_exit(&self, on: bool) {
    self.app.state::<Arc<PodModeState>>().set_rebuilding(on);
  }

  fn has_main(&self) -> bool {
    self.app.get_webview_window(MAIN_WINDOW_NAME).is_some()
  }

  async fn destroy_main(&self, timeout: Duration) -> bool {
    let Some(window) = self.app.get_webview_window(MAIN_WINDOW_NAME) else { return true };
    // Listen first, then request the destroy, so the event cannot be missed. The label is free
    // only once the runtime has processed `Destroyed`.
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = Mutex::new(Some(tx));
    window.on_window_event(move |event| {
      if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
          let _ = tx.send(());
        }
      }
    });
    if window.destroy().is_err() {
      return false;
    }
    tokio::time::timeout(timeout, rx).await.is_ok_and(|received| received.is_ok())
  }

  async fn build_main(&self) -> Result<(), ()> {
    crate::core::lifecycle::startup::setup_main_window::setup_main_window(&self.app).await.map_err(|_| ())
  }

  async fn pause(&self, duration: Duration) {
    tokio::time::sleep(duration).await;
  }
}

pub struct TauriWindows {
  app: AppHandle,
}

impl TauriWindows {
  pub fn new(app: AppHandle) -> Self {
    Self { app }
  }
}

impl Windows for TauriWindows {
  async fn rebuild(&self) -> Result<(), ()> {
    rebuild_main(&TauriSurface { app: self.app.clone() }).await.map_err(|_| ())
  }

  fn restart(&self) {
    self.app.restart();
  }
}
