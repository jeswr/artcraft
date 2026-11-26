use pod_mode::controller::Store;
use pod_mode::origin::Loopback;
use pod_mode::record::{self, PodModeRecord};
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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
  rebuild_guard: Mutex<RebuildGuard>,
  /// The policy header of the window built last. The response handler reads this live: on
  /// WebKitGTK the first window's handler stays registered for later windows (shown in a throwaway
  /// app), so a handler that captured its own copy would keep serving the first window's policy.
  policy: Mutex<Option<String>>,
  /// How many times the record has become restricted in this process (counting a restricted
  /// record at start). The hosted activity report reads it so no reporting session spans pod mode.
  restricted_periods: AtomicU64,
  /// Run each time the record becomes restricted, after it has: what was gathered for usage
  /// analytics before then is dropped at that moment, not whenever a reader next looks.
  on_restricted: Mutex<Vec<RestrictedHook>>,
}

type RestrictedHook = Box<dyn Fn() + Send + Sync>;

/// The exit guard, with the generation of the rebuild that set it last. The release of a rebuild
/// is queued on the event loop, so it can run after a later rebuild set the guard again; the
/// generation lets it end only its own rebuild's guard.
#[derive(Default)]
struct RebuildGuard {
  on: bool,
  generation: u64,
}

impl PodModeState {
  pub fn load(settings_dir: PathBuf, identifier: &str) -> Self {
    let dir = record::record_dir(&settings_dir, identifier);
    // The dialog budget is per run of the app: it starts again when the app starts outside pod mode.
    let record = record::load(&dir, Loopback::for_this_build()).effective().budget_reset_on_start();
    let restricted_periods = AtomicU64::new(u64::from(record.restricted()));
    Self { dir, record: Mutex::new(record), fresh: Mutex::new(None), rebuild_guard: Mutex::new(RebuildGuard::default()), policy: Mutex::new(None), restricted_periods, on_restricted: Mutex::new(Vec::new()) }
  }

  /// Pod mode, or pod credentials not yet confirmed wiped: no usage analytics may run.
  pub fn restricted(&self) -> bool {
    self.record.lock().unwrap_or_else(|p| p.into_inner()).restricted()
  }

  pub fn restricted_periods(&self) -> u64 {
    self.restricted_periods.load(Ordering::SeqCst)
  }

  /// Registers `hook` to run each time the record becomes restricted (not for a record that is
  /// restricted at start).
  pub fn on_restricted(&self, hook: impl Fn() + Send + Sync + 'static) {
    self.on_restricted.lock().unwrap_or_else(|p| p.into_inner()).push(Box::new(hook));
  }

  pub fn rebuilding(&self) -> bool {
    self.rebuild_guard.lock().unwrap_or_else(|p| p.into_inner()).on
  }

  /// Turns the exit guard on for a new rebuild and returns its token, for `end_rebuild`.
  pub fn begin_rebuild(&self) -> u64 {
    let mut guard = self.rebuild_guard.lock().unwrap_or_else(|p| p.into_inner());
    guard.generation += 1;
    guard.on = true;
    guard.generation
  }

  /// Turns the exit guard off, unless a later rebuild has turned it on since `token` was issued.
  pub fn end_rebuild(&self, token: u64) {
    let mut guard = self.rebuild_guard.lock().unwrap_or_else(|p| p.into_inner());
    if guard.generation == token {
      guard.on = false;
    }
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
    let became_restricted = next.restricted() && !guard.restricted();
    if became_restricted {
      self.0.restricted_periods.fetch_add(1, Ordering::SeqCst);
    }
    *guard = next.clone();
    // The hooks run after the record lock is released: a hook may take a lock under which
    // `restricted()` is read.
    drop(guard);
    if became_restricted {
      for hook in self.0.on_restricted.lock().unwrap_or_else(|p| p.into_inner()).iter() {
        hook();
      }
    }
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
  fn each_entry_into_a_restricted_record_starts_a_new_period() {
    let base = tempfile::tempdir().unwrap();
    let state = SharedPodModeState(Arc::new(PodModeState::load(base.path().to_path_buf(), "x.y")));
    let before = state.0.restricted_periods();
    assert!(!state.0.restricted());
    let entered = pod_mode::transition::enter("https://login.example", Loopback::HttpRefused).unwrap();
    state.replace(&entered).unwrap();
    let first = state.0.restricted_periods();
    assert!(state.0.restricted() && first > before);
    // Staying restricted is the same period.
    state.replace(&entered).unwrap();
    assert_eq!(state.0.restricted_periods(), first);
    state.replace(&PodModeRecord::default()).unwrap();
    assert!(!state.0.restricted());
    state.replace(&entered).unwrap();
    assert!(state.0.restricted_periods() > first);
    // A process that starts restricted has already had one.
    let again = PodModeState::load(base.path().to_path_buf(), "x.y");
    assert!(again.restricted() && again.restricted_periods() > 0);
  }

  #[test]
  fn the_restricted_hook_runs_on_each_entry_and_only_then() {
    let base = tempfile::tempdir().unwrap();
    let state = SharedPodModeState(Arc::new(PodModeState::load(base.path().to_path_buf(), "x.y")));
    let runs = Arc::new(AtomicU64::new(0));
    let seen = runs.clone();
    let observed = state.0.clone();
    // The hook sees the record already restricted, and may read it without deadlocking.
    state.0.on_restricted(move || {
      assert!(observed.restricted());
      seen.fetch_add(1, Ordering::SeqCst);
    });
    let entered = pod_mode::transition::enter("https://login.example", Loopback::HttpRefused).unwrap();
    state.replace(&entered).unwrap();
    let first = runs.load(Ordering::SeqCst);
    assert!(first > 0);
    state.replace(&entered).unwrap();
    state.replace(&PodModeRecord::default()).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), first);
    state.replace(&entered).unwrap();
    assert!(runs.load(Ordering::SeqCst) > first);
  }

  #[test]
  fn the_exit_guard_flag_round_trips() {
    let base = tempfile::tempdir().unwrap();
    let state = PodModeState::load(base.path().to_path_buf(), "x.y");
    assert!(!state.rebuilding());
    let token = state.begin_rebuild();
    assert!(state.rebuilding());
    state.end_rebuild(token);
    assert!(!state.rebuilding());
  }

  #[test]
  fn a_late_release_does_not_end_a_later_rebuilds_guard() {
    let base = tempfile::tempdir().unwrap();
    let state = PodModeState::load(base.path().to_path_buf(), "x.y");
    let first = state.begin_rebuild();
    // A second rebuild sets the guard before the first one's queued release runs.
    let second = state.begin_rebuild();
    state.end_rebuild(first);
    assert!(state.rebuilding());
    state.end_rebuild(second);
    assert!(!state.rebuilding());
  }
}
