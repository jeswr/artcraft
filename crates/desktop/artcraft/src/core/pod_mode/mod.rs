//! The app owns Solid pod mode. The page can only ask for a change; the change happens after a
//! native confirmation that names the origin. The logic lives in the `pod_mode` crate behind
//! small traits; this module supplies the Tauri side of each.

pub mod confirm;
pub mod header;
pub mod state;
pub mod window;

use crate::core::pod_mode::confirm::TauriDialog;
use crate::core::pod_mode::state::SharedPodModeState;
use crate::core::pod_mode::window::TauriWindows;
use crate::core::windows::main_window::constants::MAIN_WINDOW_NAME;
use pod_mode::controller::{Clock, Controller};
use pod_mode::origin::Loopback;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct SystemClock;

impl Clock for SystemClock {
  fn now_ms(&self) -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
  }
}

pub type PodModeController = Controller<TauriDialog, TauriWindows, SystemClock, SharedPodModeState>;

pub fn new_controller(app: tauri::AppHandle, state: SharedPodModeState) -> PodModeController {
  Controller::new(
    TauriDialog::new(app.clone()),
    TauriWindows::new(app),
    SystemClock,
    state,
    MAIN_WINDOW_NAME,
    Loopback::for_this_build(),
  )
}
