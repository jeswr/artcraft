use pod_mode::origin::Loopback;
use pod_mode::record::{self, PodModeRecord};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// The pod-mode record and the guard around changing it. The record is read from disk once at
/// start and is replaced only through `replace`, which persists first.
pub struct PodModeState {
  dir: PathBuf,
  record: Mutex<PodModeRecord>,
  /// Held while the main window is being rebuilt so the app does not exit between the old
  /// window closing and the new one opening.
  rebuilding: AtomicBool,
  /// One confirmation at a time: a second request while a dialog is open is refused.
  dialog_open: AtomicBool,
}

impl PodModeState {
  pub fn load(dir: PathBuf) -> Self {
    let record = record::load(&dir, Loopback::for_this_build()).effective();
    Self { dir, record: Mutex::new(record), rebuilding: AtomicBool::new(false), dialog_open: AtomicBool::new(false) }
  }

  pub fn record(&self) -> PodModeRecord {
    self.record.lock().map(|r| r.clone()).unwrap_or_else(|poisoned| poisoned.into_inner().clone())
  }

  /// Persists `next`, then makes it current. If the write fails nothing changes.
  pub fn replace(&self, next: PodModeRecord) -> std::io::Result<()> {
    let mut guard = self.record.lock().unwrap_or_else(|p| p.into_inner());
    record::save(&self.dir, &next)?;
    *guard = next;
    Ok(())
  }

  pub fn rebuilding(&self) -> bool {
    self.rebuilding.load(Ordering::SeqCst)
  }

  pub fn set_rebuilding(&self, value: bool) {
    self.rebuilding.store(value, Ordering::SeqCst);
  }

  /// Returns false when a confirmation is already showing.
  pub fn try_open_dialog(&self) -> bool {
    self.dialog_open.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
  }

  pub fn close_dialog(&self) {
    self.dialog_open.store(false, Ordering::SeqCst);
  }
}
