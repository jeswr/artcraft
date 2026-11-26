use crate::core::pod_mode::state::PodModeState;
use crate::core::windows::main_window::constants::MAIN_WINDOW_NAME;
use log::{error, info, warn};
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
  /// Turning the guard on takes effect at once. Turning it off is queued on the event loop: a
  /// window built from this (non-main) thread is only posted to the event loop, so `build_main`
  /// returns before the runtime has it, and the runtime handles the old window's `Destroyed` (which
  /// asks to exit when no window is left) after the listener that woke this rebuild. Dropped at
  /// once, the guard was off by then and the app exited (seen on WebKitGTK, roughly every other
  /// rebuild). Queued, it drops only after the runtime handled that `Destroyed` and created the
  /// new window, which were posted before it.
  fn guard_exit(&self, on: bool) {
    let state = self.app.state::<Arc<PodModeState>>().inner().clone();
    if on {
      state.set_rebuilding(true);
      return;
    }
    let queued = state.clone();
    if let Err(err) = self.app.run_on_main_thread(move || queued.set_rebuilding(false)) {
      warn!("pod mode: could not queue the end of the exit guard, ending it now: {err}");
      state.set_rebuilding(false);
    }
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
    if let Err(err) = window.destroy() {
      warn!("pod mode: destroying the main window failed: {err}");
      return false;
    }
    let destroyed = tokio::time::timeout(timeout, rx).await.is_ok_and(|received| received.is_ok());
    if !destroyed {
      warn!("pod mode: the main window did not report destroyed within {timeout:?}");
    }
    destroyed
  }

  async fn build_main(&self) -> Result<(), ()> {
    crate::core::lifecycle::startup::setup_main_window::setup_main_window(&self.app).await.map_err(|err| {
      warn!("pod mode: building the main window failed: {err}");
    })
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
    info!("pod mode: rebuilding the main window");
    rebuild_main(&TauriSurface { app: self.app.clone() }).await.map_err(|_| ())
  }

  fn restart(&self) {
    error!("pod mode: the main window could not be rebuilt; restarting the app");
    self.app.restart();
  }
}
