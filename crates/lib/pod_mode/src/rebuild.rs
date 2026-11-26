//! The order in which the main window is replaced. Destroying a window only posts a request:
//! its label is released when the runtime processes the `Destroyed` event, and building a new
//! window under the same label before that fails. Shown by running a throwaway Tauri 2.11.2 app
//! on WebKitGTK: an immediate build returned "a webview with label `main` already exists", and
//! a build after `Destroyed` succeeded.

use std::future::Future;
use std::time::Duration;

pub const DESTROY_TIMEOUT: Duration = Duration::from_secs(5);
pub const BUILD_ATTEMPTS: u32 = 3;
pub const BUILD_PAUSE: Duration = Duration::from_millis(250);

/// The window system, as the sequence needs it.
pub trait Surface: Send + Sync {
  /// While on, a last-window-closed exit request must be held back. Turning it off must take
  /// effect only after the window system has handled what was already posted to it (the old
  /// window's destroyed event, the new window's creation): a build can return before either.
  fn guard_exit(&self, on: bool);
  fn has_main(&self) -> bool;
  /// Starts listening for the destroyed event, then requests the destroy, then resolves `true`
  /// once the event arrived or `false` on timeout.
  fn destroy_main(&self, timeout: Duration) -> impl Future<Output = bool> + Send;
  fn build_main(&self) -> impl Future<Output = Result<(), ()>> + Send;
  fn pause(&self, duration: Duration) -> impl Future<Output = ()> + Send;
}

#[derive(Debug, PartialEq, Eq)]
pub struct RebuildFailed;

/// Replaces the main window: hold the exit guard, destroy and wait for `Destroyed`, build with a
/// few retries, and drop the guard only once the new window exists (or every attempt failed).
pub async fn rebuild_main<S: Surface>(surface: &S) -> Result<(), RebuildFailed> {
  surface.guard_exit(true);
  let result = replace(surface).await;
  surface.guard_exit(false);
  result
}

async fn replace<S: Surface>(surface: &S) -> Result<(), RebuildFailed> {
  if surface.has_main() {
    // On timeout the build is still tried: the retries below cover a late event.
    let _destroyed = surface.destroy_main(DESTROY_TIMEOUT).await;
  }
  for attempt in 0..BUILD_ATTEMPTS {
    if attempt > 0 {
      surface.pause(BUILD_PAUSE).await;
    }
    if surface.build_main().await.is_ok() {
      return Ok(());
    }
  }
  Err(RebuildFailed)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Mutex;

  /// Models the runtime: the label stays taken until the destroyed event is processed, which
  /// only happens inside `destroy_main`'s wait (or later, when `slow` is set).
  struct Fake {
    log: Mutex<Vec<String>>,
    label_taken: Mutex<bool>,
    destroy_reports: bool,
    release_after_builds: Option<u32>,
    builds: Mutex<u32>,
    build_always_fails: bool,
  }

  impl Fake {
    fn new(taken: bool) -> Self {
      Fake {
        log: Mutex::new(vec![]),
        label_taken: Mutex::new(taken),
        destroy_reports: true,
        release_after_builds: None,
        builds: Mutex::new(0),
        build_always_fails: false,
      }
    }
    fn note(&self, s: &str) {
      self.log.lock().unwrap().push(s.to_string());
    }
    fn log(&self) -> Vec<String> {
      self.log.lock().unwrap().clone()
    }
  }

  impl Surface for Fake {
    fn guard_exit(&self, on: bool) {
      self.note(if on { "guard on" } else { "guard off" });
    }
    fn has_main(&self) -> bool {
      *self.label_taken.lock().unwrap()
    }
    async fn destroy_main(&self, _timeout: Duration) -> bool {
      self.note("destroy requested");
      if self.destroy_reports {
        *self.label_taken.lock().unwrap() = false;
        self.note("destroyed event");
      }
      self.destroy_reports
    }
    async fn build_main(&self) -> Result<(), ()> {
      let mut builds = self.builds.lock().unwrap();
      *builds += 1;
      if let Some(n) = self.release_after_builds {
        if *builds > n {
          *self.label_taken.lock().unwrap() = false;
        }
      }
      if self.build_always_fails || *self.label_taken.lock().unwrap() {
        self.note("build refused");
        return Err(());
      }
      self.note("build ok");
      Ok(())
    }
    async fn pause(&self, _d: Duration) {
      self.note("pause");
    }
  }

  #[tokio::test]
  async fn builds_only_after_the_destroyed_event_and_keeps_the_guard_until_then() {
    let fake = Fake::new(true);
    assert_eq!(rebuild_main(&fake).await, Ok(()));
    assert_eq!(fake.log(), ["guard on", "destroy requested", "destroyed event", "build ok", "guard off"]);
  }

  #[tokio::test]
  async fn builds_without_destroying_when_there_is_no_window() {
    let fake = Fake::new(false);
    assert_eq!(rebuild_main(&fake).await, Ok(()));
    assert_eq!(fake.log(), ["guard on", "build ok", "guard off"]);
  }

  #[tokio::test]
  async fn retries_when_the_event_is_late_and_then_succeeds() {
    let mut fake = Fake::new(true);
    fake.destroy_reports = false;
    fake.release_after_builds = Some(1);
    assert_eq!(rebuild_main(&fake).await, Ok(()));
    assert_eq!(fake.log(), ["guard on", "destroy requested", "build refused", "pause", "build ok", "guard off"]);
  }

  #[tokio::test]
  async fn gives_up_after_the_attempts_and_still_drops_the_guard() {
    let mut fake = Fake::new(false);
    fake.build_always_fails = true;
    assert_eq!(rebuild_main(&fake).await, Err(RebuildFailed));
    assert_eq!(*fake.builds.lock().unwrap(), BUILD_ATTEMPTS);
    assert_eq!(fake.log().last().unwrap(), "guard off");
    assert_eq!(fake.log().iter().filter(|l| *l == "pause").count() as u32, BUILD_ATTEMPTS - 1);
  }
}
