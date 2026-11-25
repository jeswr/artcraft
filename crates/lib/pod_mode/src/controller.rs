//! The logic behind the app's pod-mode commands, free of any window or dialog code so it can be
//! tested without a webview. The Tauri layer supplies the dialog, the window system, the clock
//! and the store through four small traits. Only origins ever pass through here.

use crate::origin::Loopback;
use crate::record::PodModeRecord;
use crate::transition::{self, TransitionError};
use std::future::Future;
use std::io;
use tokio::sync::Mutex;

/// An answer returned sooner than this after the dialog opened cannot be a considered one (a
/// key press that was meant for something else), so it counts as a refusal.
pub const MIN_DIALOG_DISPLAY_MS: u64 = 800;
/// After a refusal the next request is turned away for this long. A refused storage origin
/// doubles it each time (`refusal_backoff_ms`).
pub const COOLDOWN_MS: u64 = 5_000;
/// The longest a back-off grows to.
pub const MAX_COOLDOWN_MS: u64 = 5 * 60 * 1_000;

/// How long to turn requests away after the `refusals`-th declined storage origin of a session:
/// 5 s, 10 s, 20 s, ... up to five minutes.
pub fn refusal_backoff_ms(refusals: usize) -> u64 {
  let doublings = refusals.saturating_sub(1).min(16) as u32;
  COOLDOWN_MS.saturating_mul(1u64 << doublings).min(MAX_COOLDOWN_MS)
}

pub struct Prompt {
  pub title: &'static str,
  pub message: String,
  /// The label of the consenting button. Any other outcome, including closing the dialog, is a
  /// refusal, and the other button is the default one.
  pub accept: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
  Accepted,
  Declined,
}

pub trait Dialog: Send + Sync {
  fn confirm(&self, prompt: &Prompt) -> impl Future<Output = Answer> + Send;
}

pub trait Clock: Send + Sync {
  fn now_ms(&self) -> u64;
}

pub trait Windows: Send + Sync {
  /// Replaces the main window so it picks up the record (see `rebuild`).
  fn rebuild(&self) -> impl Future<Output = Result<(), ()>> + Send;
  /// Last resort when the window cannot be rebuilt: restart the app, which reads the record.
  fn restart(&self);
}

pub trait Store: Send + Sync {
  fn record(&self) -> PodModeRecord;
  /// Persists first, then makes current. Nothing changes on failure.
  fn replace(&self, next: &PodModeRecord) -> io::Result<()>;
  /// The issuer of a connect the person approved in a dialog in this process, until consumed.
  fn set_fresh(&self, issuer: Option<String>);
  fn take_fresh(&self) -> Option<String>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
  Applied,
  Declined,
  /// The person pressed Allow, but sooner than a considered answer can come. Nothing changed and
  /// the origin is not remembered as refused: the page may ask again after the cool-down.
  TooFast,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Confirmation {
  Accepted,
  Declined,
  TooFast,
}

/// Closed set of failures; each is a fixed word, never an origin.
#[derive(Debug, PartialEq, Eq)]
pub enum CommandError {
  Forbidden,
  Busy,
  CoolingDown,
  InvalidOrigin,
  NotInPodMode,
  InPodMode,
  TooManyOrigins,
  Changed,
  PersistFailed,
  WindowFailed,
  NotFresh,
  /// The person already declined this origin in this pod-mode session.
  RefusedOrigin,
  /// This pod-mode session has shown its lifetime allowance of storage-origin dialogs.
  TooManyPrompts,
  /// Credentials may still be stored: finish disconnecting before connecting again.
  CredentialsPending,
}

impl CommandError {
  pub fn as_str(&self) -> &'static str {
    match self {
      CommandError::Forbidden => "forbidden",
      CommandError::Busy => "busy",
      CommandError::CoolingDown => "cooling_down",
      CommandError::InvalidOrigin => "invalid_origin",
      CommandError::NotInPodMode => "not_in_pod_mode",
      CommandError::InPodMode => "in_pod_mode",
      CommandError::TooManyOrigins => "too_many_origins",
      CommandError::Changed => "changed",
      CommandError::PersistFailed => "persist_failed",
      CommandError::WindowFailed => "window_failed",
      CommandError::NotFresh => "not_fresh",
      CommandError::RefusedOrigin => "refused_origin",
      CommandError::TooManyPrompts => "too_many_prompts",
      CommandError::CredentialsPending => "credentials_pending",
    }
  }
}

impl From<TransitionError> for CommandError {
  fn from(e: TransitionError) -> Self {
    match e {
      TransitionError::InvalidOrigin => CommandError::InvalidOrigin,
      TransitionError::NotInPodMode => CommandError::NotInPodMode,
      TransitionError::InPodMode => CommandError::InPodMode,
      TransitionError::TooManyStorageOrigins => CommandError::TooManyOrigins,
      TransitionError::RefusedOrigin => CommandError::RefusedOrigin,
      TransitionError::TooManyPrompts => CommandError::TooManyPrompts,
    }
  }
}

pub struct Controller<D, W, C, S> {
  pub dialog: D,
  pub windows: W,
  pub clock: C,
  pub store: S,
  main_label: &'static str,
  loopback: Loopback,
  /// One request at a time, across all commands. A second one while this is held is rejected.
  in_flight: Mutex<()>,
  /// The time before which new confirmations are refused.
  cooldown_until_ms: std::sync::atomic::AtomicU64,
}

impl<D: Dialog, W: Windows, C: Clock, S: Store> Controller<D, W, C, S> {
  pub fn new(dialog: D, windows: W, clock: C, store: S, main_label: &'static str, loopback: Loopback) -> Self {
    Self {
      dialog,
      windows,
      clock,
      store,
      main_label,
      loopback,
      in_flight: Mutex::new(()),
      cooldown_until_ms: std::sync::atomic::AtomicU64::new(0),
    }
  }

  /// Enter pod mode for `issuer`: native confirmation naming it, persist, remember the approval
  /// in memory, rebuild the window.
  pub async fn enter(&self, caller: &str, issuer: &str) -> Result<Reply, CommandError> {
    self.only_main(caller)?;
    let _turn = self.in_flight.try_lock().map_err(|_| CommandError::Busy)?;
    let before = self.store.record();
    // One issuer at a time, and never over credentials that were not confirmed wiped: swapping
    // the issuer from inside pod mode, or connecting from a finishing window, needs a leave first.
    if before.enabled {
      return Err(CommandError::InPodMode);
    }
    if before.credentials_may_exist {
      return Err(CommandError::CredentialsPending);
    }
    let next = transition::enter(issuer, self.loopback)?;
    let origin = next.issuer.clone().unwrap_or_default();
    let prompt = Prompt {
      title: "Enter Solid pod mode",
      message: format!(
        "ArtCraft will restart this window in Solid pod mode for the sign-in server:\n\n{origin}\n\n\
In pod mode ArtCraft loads no analytics and may only contact that server, the servers you add \
later, and ArtCraft's own services. Only continue if you started this and trust that server."
      ),
      accept: "Enter pod mode",
    };
    if !self.confirmed(&prompt).await? {
      return Ok(Reply::Declined);
    }
    self.persist(&before, &next)?;
    self.store.set_fresh(Some(origin));
    self.rebuilt().await?;
    Ok(Reply::Applied)
  }

  /// Admit one more storage origin: same pattern, so the origin is only ever added after a
  /// native dialog that names it. An origin already admitted, or the issuer's own, needs no
  /// dialog. The limits live here, not in the page, because a compromised page can call this
  /// command directly: an origin the person declined is never shown again in this pod-mode
  /// session, a session shows a fixed number of dialogs in all (counted before each opens and
  /// persisted), and each refusal doubles the wait before the next dialog. The dialog says only
  /// what the app knows: that something asked, and that the window reloads.
  pub async fn add_storage_origin(&self, caller: &str, origin: &str) -> Result<Reply, CommandError> {
    self.only_main(caller)?;
    let _turn = self.in_flight.try_lock().map_err(|_| CommandError::Busy)?;
    let before = self.store.record();
    let wanted = transition::add_storage_origin(&before, origin, self.loopback)?;
    if wanted == before {
      return Ok(Reply::Applied);
    }
    let shown = wanted.storage_origins.last().cloned().unwrap_or_default();
    transition::may_prompt(&before, &shown)?;
    self.check_cooldown()?;
    let counted = transition::prompt_shown(&before);
    self.persist(&before, &counted)?;
    let prompt = Prompt {
      title: "Connect to another server?",
      message: format!(
        "ArtCraft is asking to connect to:\n\n{shown}\n\n\
Only allow this if it is where your Solid pod or profile lives. ArtCraft cannot check why it \
is being asked. If you allow it, this window will reload."
      ),
      accept: "Allow",
    };
    match self.ask(&prompt).await {
      Confirmation::Accepted => {
        let next = transition::add_storage_origin(&counted, &shown, self.loopback)?;
        self.persist(&counted, &next)?;
        self.store.set_fresh(None);
        self.rebuilt().await?;
        Ok(Reply::Applied)
      }
      Confirmation::Declined => {
        let next = transition::refused(&counted, &shown);
        self.persist(&counted, &next)?;
        self.cool_down(refusal_backoff_ms(next.refused_origins.len()));
        Ok(Reply::Declined)
      }
      Confirmation::TooFast => {
        self.cool_down(COOLDOWN_MS);
        Ok(Reply::TooFast)
      }
    }
  }

  /// Leave pod mode. The window asks after its own wipe reported success, but the app cannot
  /// check that, so the record keeps `credentials_may_exist` set and the rebuilt window is a
  /// restricted "finishing" window. The flag clears only when that window confirms a wipe
  /// through `credentials_cleared`; a quit or a failure before then leaves it set for the
  /// next launch.
  pub async fn leave(&self, caller: &str) -> Result<Reply, CommandError> {
    self.only_main(caller)?;
    let _turn = self.in_flight.try_lock().map_err(|_| CommandError::Busy)?;
    let before = self.store.record();
    let next = transition::leave(&before)?;
    self.persist(&before, &next)?;
    self.store.set_fresh(None);
    self.rebuilt().await?;
    Ok(Reply::Applied)
  }

  /// A wipe succeeded in a window that is not in pod mode: the credentials flag clears. This is
  /// the only command that clears it.
  pub async fn credentials_cleared(&self, caller: &str) -> Result<Reply, CommandError> {
    self.only_main(caller)?;
    let _turn = self.in_flight.try_lock().map_err(|_| CommandError::Busy)?;
    let before = self.store.record();
    let next = transition::credentials_cleared(&before)?;
    if next == before {
      // Nothing to clear: an ordinary window's scripts must not be able to destroy it in a loop.
      return Ok(Reply::Applied);
    }
    self.persist(&before, &next)?;
    self.rebuilt().await?;
    Ok(Reply::Applied)
  }

  /// Rebuild in the mode the window is already in, to close its storage connections. Only a
  /// restricted window (pod mode, or credentials not yet confirmed wiped) may ask: in an
  /// ordinary window, where third-party scripts run, nothing needs it.
  pub async fn reload(&self, caller: &str) -> Result<Reply, CommandError> {
    self.only_main(caller)?;
    let _turn = self.in_flight.try_lock().map_err(|_| CommandError::Busy)?;
    if !self.store.record().restricted() {
      return Err(CommandError::NotInPodMode);
    }
    self.store.set_fresh(None);
    self.rebuilt().await?;
    Ok(Reply::Applied)
  }

  /// The click that starts a fresh sign-in: hands out the issuer of the connect approved in
  /// this process, once. A record loaded from disk never yields one.
  pub async fn consume_fresh(&self, caller: &str) -> Result<String, CommandError> {
    self.only_main(caller)?;
    let _turn = self.in_flight.try_lock().map_err(|_| CommandError::Busy)?;
    if !self.store.record().enabled {
      return Err(CommandError::NotInPodMode);
    }
    self.store.take_fresh().ok_or(CommandError::NotFresh)
  }

  fn only_main(&self, caller: &str) -> Result<(), CommandError> {
    if caller == self.main_label { Ok(()) } else { Err(CommandError::Forbidden) }
  }

  /// The dialog of `enter`: only an accepted answer that took a human's time counts; anything
  /// else, too fast included, starts a cool-down. Cool-down is checked before the dialog opens.
  async fn confirmed(&self, prompt: &Prompt) -> Result<bool, CommandError> {
    self.check_cooldown()?;
    if self.ask(prompt).await == Confirmation::Accepted {
      return Ok(true);
    }
    self.cool_down(COOLDOWN_MS);
    Ok(false)
  }

  /// Shows a dialog. An Allow that came back sooner than `MIN_DIALOG_DISPLAY_MS` is `TooFast`,
  /// not a refusal: the person is not recorded as having said no.
  async fn ask(&self, prompt: &Prompt) -> Confirmation {
    let opened = self.clock.now_ms();
    let answer = self.dialog.confirm(prompt).await;
    let shown_for = self.clock.now_ms().saturating_sub(opened);
    match answer {
      Answer::Accepted if shown_for >= MIN_DIALOG_DISPLAY_MS => Confirmation::Accepted,
      Answer::Accepted => Confirmation::TooFast,
      Answer::Declined => Confirmation::Declined,
    }
  }

  fn check_cooldown(&self) -> Result<(), CommandError> {
    use std::sync::atomic::Ordering::SeqCst;
    if self.clock.now_ms() < self.cooldown_until_ms.load(SeqCst) {
      return Err(CommandError::CoolingDown);
    }
    Ok(())
  }

  fn cool_down(&self, ms: u64) {
    use std::sync::atomic::Ordering::SeqCst;
    self.cooldown_until_ms.store(self.clock.now_ms().saturating_add(ms), SeqCst);
  }

  /// Persists `next` unless the record changed while the dialog was open.
  fn persist(&self, before: &PodModeRecord, next: &PodModeRecord) -> Result<(), CommandError> {
    if &self.store.record() != before {
      return Err(CommandError::Changed);
    }
    self.store.replace(next).map_err(|_| CommandError::PersistFailed)
  }

  async fn rebuilt(&self) -> Result<(), CommandError> {
    if self.windows.rebuild().await.is_ok() {
      return Ok(());
    }
    self.windows.restart();
    Err(CommandError::WindowFailed)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::origin::Loopback::HttpRefused;
  use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
  use std::sync::{Arc, Mutex as StdMutex};
  use tokio::sync::Notify;

  const MAIN: &str = "main";
  const ISSUER: &str = "https://login.example";

  #[derive(Default)]
  struct World {
    now: AtomicU64,
    record: StdMutex<PodModeRecord>,
    fresh: StdMutex<Option<String>>,
    persisted: StdMutex<Vec<PodModeRecord>>,
    persist_fails: StdMutex<bool>,
    rebuilds: AtomicU64,
    rebuild_fails: StdMutex<bool>,
    restarts: AtomicU64,
    prompts: StdMutex<Vec<String>>,
    /// What the dialog answers and how long it stays open.
    answer: StdMutex<Option<(Answer, u64)>>,
    /// While set, the dialog waits for this before answering.
    hold: StdMutex<Option<Arc<Notify>>>,
    /// Run while the dialog is open.
    during: StdMutex<Option<Box<dyn Fn(&World) + Send>>>,
  }

  struct Dlg(Arc<World>);
  struct Win(Arc<World>);
  struct Clk(Arc<World>);
  struct Sto(Arc<World>);

  impl Dialog for Dlg {
    async fn confirm(&self, prompt: &Prompt) -> Answer {
      let w = &self.0;
      w.prompts.lock().unwrap().push(prompt.message.clone());
      let hold = w.hold.lock().unwrap().clone();
      if let Some(n) = hold {
        n.notified().await;
      }
      if let Some(f) = w.during.lock().unwrap().as_ref() {
        f(w);
      }
      let (answer, open_ms) = w.answer.lock().unwrap().unwrap_or((Answer::Accepted, 2_000));
      w.now.fetch_add(open_ms, SeqCst);
      answer
    }
  }
  impl Windows for Win {
    async fn rebuild(&self) -> Result<(), ()> {
      self.0.rebuilds.fetch_add(1, SeqCst);
      if *self.0.rebuild_fails.lock().unwrap() { Err(()) } else { Ok(()) }
    }
    fn restart(&self) {
      self.0.restarts.fetch_add(1, SeqCst);
    }
  }
  impl Clock for Clk {
    fn now_ms(&self) -> u64 {
      self.0.now.load(SeqCst)
    }
  }
  impl Store for Sto {
    fn record(&self) -> PodModeRecord {
      self.0.record.lock().unwrap().clone()
    }
    fn replace(&self, next: &PodModeRecord) -> io::Result<()> {
      if *self.0.persist_fails.lock().unwrap() {
        return Err(io::Error::other("disk"));
      }
      self.0.persisted.lock().unwrap().push(next.clone());
      *self.0.record.lock().unwrap() = next.clone();
      Ok(())
    }
    fn set_fresh(&self, issuer: Option<String>) {
      *self.0.fresh.lock().unwrap() = issuer;
    }
    fn take_fresh(&self) -> Option<String> {
      self.0.fresh.lock().unwrap().take()
    }
  }

  fn world() -> (Arc<World>, Controller<Dlg, Win, Clk, Sto>) {
    let w = Arc::new(World::default());
    w.now.store(100_000, SeqCst);
    let c = Controller::new(Dlg(w.clone()), Win(w.clone()), Clk(w.clone()), Sto(w.clone()), MAIN, HttpRefused);
    (w, c)
  }

  fn in_pod_mode(w: &World) {
    *w.record.lock().unwrap() = transition::enter(ISSUER, HttpRefused).unwrap();
  }

  #[tokio::test]
  async fn enter_persists_remembers_the_approval_and_rebuilds_after_an_accepted_dialog() {
    let (w, c) = world();
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
    assert!(w.prompts.lock().unwrap()[0].contains(ISSUER));
    let record = w.record.lock().unwrap().clone();
    assert!(record.enabled && record.credentials_may_exist);
    assert_eq!(record.issuer.as_deref(), Some(ISSUER));
    assert_eq!(w.persisted.lock().unwrap().len(), 1);
    assert_eq!(w.fresh.lock().unwrap().as_deref(), Some(ISSUER));
    assert_eq!(w.rebuilds.load(SeqCst), 1);
  }

  #[tokio::test]
  async fn enter_changes_nothing_when_the_dialog_is_declined() {
    let (w, c) = world();
    *w.answer.lock().unwrap() = Some((Answer::Declined, 3_000));
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Declined));
    assert!(w.persisted.lock().unwrap().is_empty());
    assert!(w.fresh.lock().unwrap().is_none());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
    assert!(!w.record.lock().unwrap().enabled);
  }

  #[tokio::test]
  async fn an_answer_that_comes_back_too_fast_is_a_refusal_and_starts_a_cool_down() {
    let (w, c) = world();
    *w.answer.lock().unwrap() = Some((Answer::Accepted, MIN_DIALOG_DISPLAY_MS - 1));
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Declined));
    assert!(w.persisted.lock().unwrap().is_empty());
    // Straight away: turned away without a dialog.
    let shown = w.prompts.lock().unwrap().len();
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::CoolingDown));
    assert_eq!(w.prompts.lock().unwrap().len(), shown);
    // After the cool-down a considered accept works.
    w.now.fetch_add(COOLDOWN_MS + 1, SeqCst);
    *w.answer.lock().unwrap() = Some((Answer::Accepted, MIN_DIALOG_DISPLAY_MS));
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn a_refused_storage_origin_cools_the_next_dialog_down() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 5_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Declined));
    assert_eq!(c.add_storage_origin(MAIN, "https://other.example").await, Err(CommandError::CoolingDown));
    assert_eq!(w.prompts.lock().unwrap().len(), 1);
  }

  #[tokio::test]
  async fn only_the_main_window_may_call_and_nothing_happens_for_others() {
    let (w, c) = world();
    in_pod_mode(&w);
    for caller in ["login", "sora", "", "MAIN", "main "] {
      assert_eq!(c.enter(caller, ISSUER).await, Err(CommandError::Forbidden));
      assert_eq!(c.add_storage_origin(caller, "https://pod.example").await, Err(CommandError::Forbidden));
      assert_eq!(c.leave(caller).await, Err(CommandError::Forbidden));
      assert_eq!(c.reload(caller).await, Err(CommandError::Forbidden));
      assert_eq!(c.credentials_cleared(caller).await, Err(CommandError::Forbidden));
      assert_eq!(c.consume_fresh(caller).await, Err(CommandError::Forbidden));
    }
    assert!(w.prompts.lock().unwrap().is_empty());
    assert!(w.persisted.lock().unwrap().is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
  }

  #[tokio::test]
  async fn invalid_origins_are_refused_before_any_dialog() {
    let (w, c) = world();
    assert_eq!(c.enter(MAIN, "http://login.example").await, Err(CommandError::InvalidOrigin));
    assert_eq!(c.enter(MAIN, "https://login.example/x").await, Err(CommandError::InvalidOrigin));
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example; x").await, Err(CommandError::InvalidOrigin));
    assert!(w.prompts.lock().unwrap().is_empty());
  }

  #[tokio::test]
  async fn adding_a_storage_origin_asks_once_and_a_known_origin_needs_no_dialog() {
    let (w, c) = world();
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Err(CommandError::NotInPodMode));
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Applied));
    assert!(w.prompts.lock().unwrap()[0].contains("https://pod.example"));
    assert_eq!(w.record.lock().unwrap().storage_origins, ["https://pod.example"]);
    let prompts = w.prompts.lock().unwrap().len();
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Applied));
    assert_eq!(w.prompts.lock().unwrap().len(), prompts);
  }

  #[tokio::test]
  async fn the_issuer_origin_needs_no_dialog_and_no_rebuild() {
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, ISSUER).await, Ok(Reply::Applied));
    assert!(w.prompts.lock().unwrap().is_empty());
    assert!(w.persisted.lock().unwrap().is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
  }

  #[tokio::test]
  async fn a_declined_storage_origin_is_not_added_and_the_next_ask_is_turned_away_for_a_while() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 3_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://evil.example").await, Ok(Reply::Declined));
    assert!(w.record.lock().unwrap().storage_origins.is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
    assert_eq!(c.add_storage_origin(MAIN, "https://other.example").await, Err(CommandError::CoolingDown));
    assert_eq!(w.prompts.lock().unwrap().len(), 1);
  }

  #[tokio::test]
  async fn a_session_shows_a_fixed_number_of_storage_dialogs_in_all_and_then_none() {
    use crate::record::MAX_STORAGE_PROMPTS;
    let (w, c) = world();
    in_pod_mode(&w);
    for i in 0..MAX_STORAGE_PROMPTS {
      assert_eq!(c.add_storage_origin(MAIN, &format!("https://pod{i}.example")).await, Ok(Reply::Applied));
    }
    let shown = w.prompts.lock().unwrap().len();
    assert_eq!(shown, MAX_STORAGE_PROMPTS as usize);
    assert_eq!(c.add_storage_origin(MAIN, "https://one-more.example").await, Err(CommandError::TooManyPrompts));
    assert_eq!(w.prompts.lock().unwrap().len(), shown, "no dialog past the allowance");
    // An origin that is already admitted still answers, without a dialog.
    assert_eq!(c.add_storage_origin(MAIN, "https://pod0.example").await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn the_dialog_is_counted_and_saved_before_it_opens_so_quitting_with_it_open_gains_nothing() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.during.lock().unwrap() = Some(Box::new(|w| {
      assert_eq!(w.record.lock().unwrap().storage_prompts, 1);
      assert_eq!(w.persisted.lock().unwrap().last().unwrap().storage_prompts, 1);
    }));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn a_declined_origin_is_remembered_and_never_asked_about_again_this_session() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 3_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://evil.example").await, Ok(Reply::Declined));
    assert_eq!(w.record.lock().unwrap().refused_origins, ["https://evil.example"]);
    // Even a fresh controller reading the persisted record (a relaunch) refuses without a dialog.
    let saved = w.record.lock().unwrap().clone();
    let (w2, c2) = world();
    *w2.record.lock().unwrap() = saved;
    assert_eq!(c2.add_storage_origin(MAIN, "https://evil.example").await, Err(CommandError::RefusedOrigin));
    assert!(w2.prompts.lock().unwrap().is_empty());
    // Another origin is still allowed to ask.
    *w2.answer.lock().unwrap() = Some((Answer::Accepted, 2_000));
    assert_eq!(c2.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn each_refusal_doubles_the_wait_before_the_next_dialog() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example").await, Ok(Reply::Declined));
    w.now.fetch_add(COOLDOWN_MS - 1, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://b.example").await, Err(CommandError::CoolingDown));
    w.now.fetch_add(2, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://b.example").await, Ok(Reply::Declined));
    // The second wait is twice as long.
    w.now.fetch_add(COOLDOWN_MS + 1, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://c.example").await, Err(CommandError::CoolingDown));
    w.now.fetch_add(COOLDOWN_MS, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://c.example").await, Ok(Reply::Declined));
  }

  #[test]
  fn the_back_off_doubles_and_is_capped() {
    assert_eq!(refusal_backoff_ms(0), COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(1), COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(2), 2 * COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(3), 4 * COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(1_000), MAX_COOLDOWN_MS);
  }

  #[tokio::test]
  async fn an_allow_that_comes_too_fast_is_reported_as_such_and_is_not_a_refusal() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Accepted, MIN_DIALOG_DISPLAY_MS - 1));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::TooFast));
    let record = w.record.lock().unwrap().clone();
    assert!(record.refused_origins.is_empty() && record.storage_origins.is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
    // After the cool-down a considered Allow for the same origin works.
    w.now.fetch_add(COOLDOWN_MS + 1, SeqCst);
    *w.answer.lock().unwrap() = Some((Answer::Accepted, 2_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn the_dialog_names_only_what_the_app_knows_and_says_the_window_reloads() {
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Applied));
    let text = w.prompts.lock().unwrap()[0].clone();
    assert!(text.contains("https://pod.example") && text.contains("reload"));
    assert!(!text.contains("profile points") && !text.contains("comes from your profile"));
  }

  #[tokio::test]
  async fn an_allowed_origin_is_in_the_policy_and_the_script_of_the_rebuilt_window() {
    use crate::{csp::build_pod_mode_csp, host_script::host_init_script};
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Ok(Reply::Applied));
    assert_eq!(w.rebuilds.load(SeqCst), 1);
    // What the rebuilt window is built from is the persisted record.
    let record = w.persisted.lock().unwrap().last().cloned().unwrap();
    let csp = build_pod_mode_csp(record.issuer.as_deref(), &record.storage_origins, HttpRefused).unwrap();
    assert!(csp.contains("https://pod.example"));
    assert!(host_init_script(&record, true, "x.y", None).contains(r#""storageOrigins":["https://pod.example"]"#));
  }

  #[tokio::test]
  async fn leave_ends_pod_mode_but_keeps_the_credentials_flag_and_forgets_the_approval() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.fresh.lock().unwrap() = Some(ISSUER.into());
    assert_eq!(c.leave(MAIN).await, Ok(Reply::Applied));
    let record = w.record.lock().unwrap().clone();
    assert!(!record.enabled && record.issuer.is_none() && record.storage_origins.is_empty());
    assert!(record.credentials_may_exist, "only a confirmed wipe may clear the flag");
    assert!(record.restricted());
    assert!(w.fresh.lock().unwrap().is_none());
    assert_eq!(w.rebuilds.load(SeqCst), 1);
  }

  #[tokio::test]
  async fn leave_outside_pod_mode_is_refused_and_changes_nothing() {
    let (w, c) = world();
    assert_eq!(c.leave(MAIN).await, Err(CommandError::NotInPodMode));
    assert!(w.persisted.lock().unwrap().is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
  }

  #[tokio::test]
  async fn a_disconnect_interrupted_after_leave_leaves_the_flag_for_the_next_launch() {
    let (w, c) = world();
    in_pod_mode(&w);
    // The window cannot be rebuilt, so the app restarts; the finishing window never gets to confirm.
    *w.rebuild_fails.lock().unwrap() = true;
    assert_eq!(c.leave(MAIN).await, Err(CommandError::WindowFailed));
    assert_eq!(w.restarts.load(SeqCst), 1);
    let on_disk = w.persisted.lock().unwrap().last().cloned().unwrap();
    assert!(!on_disk.enabled && on_disk.credentials_may_exist);
    // Next launch: a new controller reading what was persisted. It is still restricted, and
    // nothing but a wipe confirmation clears it.
    let (w2, c2) = world();
    *w2.record.lock().unwrap() = on_disk;
    assert!(w2.record.lock().unwrap().restricted());
    assert_eq!(c2.leave(MAIN).await, Err(CommandError::NotInPodMode));
    assert_eq!(c2.reload(MAIN).await, Ok(Reply::Applied));
    assert!(w2.record.lock().unwrap().credentials_may_exist, "a reload does not clear it");
    assert_eq!(c2.credentials_cleared(MAIN).await, Ok(Reply::Applied));
    assert_eq!(*w2.record.lock().unwrap(), PodModeRecord::default());
  }

  #[tokio::test]
  async fn a_failed_write_on_leave_keeps_the_pod_mode_record() {
    let (w, c) = world();
    in_pod_mode(&w);
    let before = w.record.lock().unwrap().clone();
    *w.persist_fails.lock().unwrap() = true;
    assert_eq!(c.leave(MAIN).await, Err(CommandError::PersistFailed));
    assert_eq!(*w.record.lock().unwrap(), before);
    assert_eq!(w.rebuilds.load(SeqCst), 0);
  }

  #[tokio::test]
  async fn the_credentials_flag_clears_only_outside_pod_mode() {
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.credentials_cleared(MAIN).await, Err(CommandError::InPodMode));
    *w.record.lock().unwrap() = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    assert_eq!(c.credentials_cleared(MAIN).await, Ok(Reply::Applied));
    assert!(!w.record.lock().unwrap().credentials_may_exist);
    assert_eq!(w.rebuilds.load(SeqCst), 1);
  }

  #[tokio::test]
  async fn a_fresh_connect_is_handed_out_once_and_only_after_a_dialog_in_this_process() {
    let (w, c) = world();
    // A record loaded from disk (pod mode, no dialog in this process) cannot start a sign-in.
    in_pod_mode(&w);
    assert_eq!(c.consume_fresh(MAIN).await, Err(CommandError::NotFresh));
    *w.record.lock().unwrap() = PodModeRecord::default();
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
    assert_eq!(c.consume_fresh(MAIN).await.as_deref(), Ok(ISSUER));
    assert_eq!(c.consume_fresh(MAIN).await, Err(CommandError::NotFresh));
  }

  #[tokio::test]
  async fn a_reload_forgets_an_unused_approval() {
    let (w, c) = world();
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
    assert_eq!(c.reload(MAIN).await, Ok(Reply::Applied));
    assert_eq!(c.consume_fresh(MAIN).await, Err(CommandError::NotFresh));
    assert_eq!(w.rebuilds.load(SeqCst), 2);
  }

  #[tokio::test]
  async fn a_failed_write_changes_nothing_and_does_not_rebuild() {
    let (w, c) = world();
    *w.persist_fails.lock().unwrap() = true;
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::PersistFailed));
    assert!(!w.record.lock().unwrap().enabled);
    assert!(w.fresh.lock().unwrap().is_none());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
  }

  #[tokio::test]
  async fn a_window_that_cannot_be_rebuilt_restarts_the_app() {
    let (w, c) = world();
    *w.rebuild_fails.lock().unwrap() = true;
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::WindowFailed));
    assert_eq!(w.restarts.load(SeqCst), 1);
    assert!(w.record.lock().unwrap().enabled, "the record was already saved, so the restart picks it up");
  }

  #[tokio::test]
  async fn a_record_that_changed_while_the_dialog_was_open_is_not_overwritten() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.during.lock().unwrap() = Some(Box::new(|w| *w.record.lock().unwrap() = PodModeRecord::default()));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example").await, Err(CommandError::Changed));
    assert_eq!(*w.record.lock().unwrap(), PodModeRecord::default());
    assert_eq!(w.persisted.lock().unwrap().len(), 1, "only the dialog count was saved before the dialog");
    assert_eq!(w.rebuilds.load(SeqCst), 0);
  }

  #[tokio::test]
  async fn a_second_request_while_one_is_in_flight_is_rejected_for_every_command() {
    let (w, c) = world();
    let gate = Arc::new(Notify::new());
    *w.hold.lock().unwrap() = Some(gate.clone());
    let first = c.enter(MAIN, ISSUER);
    let second = async {
      // Let the first reach its dialog, then try everything else.
      tokio::task::yield_now().await;
      let results = (
        c.enter(MAIN, "https://other.example").await,
        c.add_storage_origin(MAIN, "https://pod.example").await,
        c.leave(MAIN).await,
        c.reload(MAIN).await,
        c.credentials_cleared(MAIN).await,
        c.consume_fresh(MAIN).await.map(|_| Reply::Applied),
      );
      gate.notify_one();
      results
    };
    let (first, (a, b, l, r, cc, f)) = tokio::join!(first, second);
    assert_eq!(first, Ok(Reply::Applied));
    for result in [a, b, l, r, cc, f] {
      assert_eq!(result, Err(CommandError::Busy));
    }
    assert_eq!(w.rebuilds.load(SeqCst), 1);
  }

  #[tokio::test]
  async fn connecting_needs_an_ordinary_clean_window() {
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.enter(MAIN, "https://other.example").await, Err(CommandError::InPodMode));
    assert!(w.prompts.lock().unwrap().is_empty());
    // A finishing window (credentials may exist, pod mode off) must finish first.
    *w.record.lock().unwrap() = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::CredentialsPending));
    assert!(w.prompts.lock().unwrap().is_empty());
    assert_eq!(c.credentials_cleared(MAIN).await, Ok(Reply::Applied));
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn leaving_and_connecting_again_starts_a_new_dialog_budget() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example").await, Ok(Reply::Declined));
    *w.answer.lock().unwrap() = None;
    assert_eq!(c.leave(MAIN).await, Ok(Reply::Applied));
    assert_eq!(c.credentials_cleared(MAIN).await, Ok(Reply::Applied));
    w.now.fetch_add(MAX_COOLDOWN_MS, SeqCst);
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
    let record = w.record.lock().unwrap().clone();
    assert_eq!((record.storage_prompts, record.refused_origins.len()), (0, 0));
  }

  #[tokio::test]
  async fn a_no_op_wipe_confirmation_or_a_reload_in_an_ordinary_window_does_not_rebuild_it() {
    let (w, c) = world();
    assert_eq!(c.credentials_cleared(MAIN).await, Ok(Reply::Applied));
    assert_eq!(c.reload(MAIN).await, Err(CommandError::NotInPodMode));
    assert_eq!(w.rebuilds.load(SeqCst), 0);
    assert!(w.persisted.lock().unwrap().is_empty());
    // A restricted window may still reload (to close its storage connections).
    *w.record.lock().unwrap() = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    assert_eq!(c.reload(MAIN).await, Ok(Reply::Applied));
    assert_eq!(w.rebuilds.load(SeqCst), 1);
  }

  #[test]
  fn every_error_has_its_own_fixed_word() {
    let all = [
      CommandError::Forbidden,
      CommandError::Busy,
      CommandError::CoolingDown,
      CommandError::InvalidOrigin,
      CommandError::NotInPodMode,
      CommandError::InPodMode,
      CommandError::TooManyOrigins,
      CommandError::Changed,
      CommandError::PersistFailed,
      CommandError::WindowFailed,
      CommandError::NotFresh,
      CommandError::RefusedOrigin,
      CommandError::TooManyPrompts,
      CommandError::CredentialsPending,
    ];
    let words: std::collections::HashSet<_> = all.iter().map(CommandError::as_str).collect();
    assert_eq!(words.len(), all.len());
    assert!(words.iter().all(|w| w.chars().all(|c| c.is_ascii_lowercase() || c == '_')));
  }
}
