use pod_mode::controller::Store;
use pod_mode::origin::Loopback;
use pod_mode::record::{self, PodModeRecord};
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The pod-mode record, read from disk once at start and replaced only through `replace`, which
/// persists first. The record lives in a directory named for the app identifier, so a dev build
/// and a release build never share it. `fresh` is process memory only: the issuer of a connect
/// the person approved in a dialog in this process. It is never written anywhere.
pub struct PodModeState {
  dir: PathBuf,
  record: Mutex<PodModeRecord>,
  fresh: Mutex<Option<String>>,
  /// Held while the main window is being rebuilt so the app does not exit in between.
  rebuilding: AtomicBool,
  /// The policy header of the window built last. The response handler reads this live: on
  /// WebKitGTK the first window's handler stays registered for later windows (shown in a throwaway
  /// app), so a handler that captured its own copy would keep serving the first window's policy.
  policy: Mutex<Option<String>>,
}

impl PodModeState {
  pub fn load(settings_dir: PathBuf, identifier: &str) -> Self {
    let dir = record::record_dir(&settings_dir, identifier);
    // The dialog budget is per run of the app: it starts again when the app starts outside pod mode.
    let record = record::load(&dir, Loopback::for_this_build()).effective().budget_reset_on_start();
    Self { dir, record: Mutex::new(record), fresh: Mutex::new(None), rebuilding: AtomicBool::new(false), policy: Mutex::new(None) }
  }

  pub fn rebuilding(&self) -> bool {
    self.rebuilding.load(Ordering::SeqCst)
  }

  pub fn set_rebuilding(&self, value: bool) {
    self.rebuilding.store(value, Ordering::SeqCst);
  }

  pub fn set_policy(&self, policy: Option<String>) {
    *self.policy.lock().unwrap_or_else(|p| p.into_inner()) = policy;
  }

  pub fn policy(&self) -> Option<String> {
    self.policy.lock().unwrap_or_else(|p| p.into_inner()).clone()
  }

  pub fn fresh_connect(&self) -> Option<String> {
    self.fresh.lock().unwrap_or_else(|p| p.into_inner()).clone()
  }
}

#[derive(Clone)]
pub struct SharedPodModeState(pub Arc<PodModeState>);

impl Store for SharedPodModeState {
  fn record(&self) -> PodModeRecord {
    self.0.record.lock().unwrap_or_else(|p| p.into_inner()).clone()
  }

  fn replace(&self, next: &PodModeRecord) -> io::Result<()> {
    let mut guard = self.0.record.lock().unwrap_or_else(|p| p.into_inner());
    record::save(&self.0.dir, next)?;
    *guard = next.clone();
    Ok(())
  }

  fn set_fresh(&self, issuer: Option<String>) {
    *self.0.fresh.lock().unwrap_or_else(|p| p.into_inner()) = issuer;
  }

  fn take_fresh(&self) -> Option<String> {
    self.0.fresh.lock().unwrap_or_else(|p| p.into_inner()).take()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_replaced_record_is_on_disk_and_survives_a_reload() {
    let base = tempfile::tempdir().unwrap();
    let state = SharedPodModeState(Arc::new(PodModeState::load(base.path().to_path_buf(), "ai.artcraft.app")));
    let next = pod_mode::transition::enter("https://login.example", Loopback::HttpRefused).unwrap();
    state.replace(&next).unwrap();
    assert_eq!(state.record(), next);
    let again = PodModeState::load(base.path().to_path_buf(), "ai.artcraft.app");
    assert_eq!(again.record.lock().unwrap().clone(), next);
    // Another identifier sees nothing.
    let dev = PodModeState::load(base.path().to_path_buf(), "ai.artcraft.app.dev");
    assert_eq!(dev.record.lock().unwrap().clone(), PodModeRecord::default());
  }

  #[test]
  fn a_failed_write_leaves_the_record_as_it_was() {
    let base = tempfile::tempdir().unwrap();
    let state = SharedPodModeState(Arc::new(PodModeState::load(base.path().to_path_buf(), "x.y")));
    // The directory path is occupied by a file, so the write fails.
    std::fs::remove_dir_all(base.path().join("pod_mode")).ok();
    std::fs::write(base.path().join("pod_mode"), b"x").unwrap();
    let next = pod_mode::transition::enter("https://login.example", Loopback::HttpRefused).unwrap();
    assert!(state.replace(&next).is_err());
    assert_eq!(state.record(), PodModeRecord::default());
  }

  #[test]
  fn the_approval_lives_in_memory_and_is_taken_once() {
    let base = tempfile::tempdir().unwrap();
    let state = SharedPodModeState(Arc::new(PodModeState::load(base.path().to_path_buf(), "x.y")));
    assert_eq!(state.take_fresh(), None);
    state.set_fresh(Some("https://login.example".into()));
    assert_eq!(state.0.fresh_connect().as_deref(), Some("https://login.example"));
    assert_eq!(state.take_fresh().as_deref(), Some("https://login.example"));
    assert_eq!(state.take_fresh(), None);
  }

  #[test]
  fn the_policy_is_read_live_so_a_later_window_replaces_an_earlier_one() {
    let base = tempfile::tempdir().unwrap();
    let state = PodModeState::load(base.path().to_path_buf(), "x.y");
    assert_eq!(state.policy(), None);
    state.set_policy(Some("a".into()));
    state.set_policy(Some("b".into()));
    assert_eq!(state.policy().as_deref(), Some("b"));
    state.set_policy(None);
    assert_eq!(state.policy(), None);
  }

  #[test]
  fn the_exit_guard_flag_round_trips() {
    let base = tempfile::tempdir().unwrap();
    let state = PodModeState::load(base.path().to_path_buf(), "x.y");
    assert!(!state.rebuilding());
    state.set_rebuilding(true);
    assert!(state.rebuilding());
  }
}
