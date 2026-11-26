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
/// After a refusal the next request is turned away for this long. Each further refusal since the
/// app started doubles it (`refusal_backoff_ms`).
pub const COOLDOWN_MS: u64 = 5_000;
/// The longest a back-off grows to.
pub const MAX_COOLDOWN_MS: u64 = 5 * 60 * 1_000;
/// The most "sign in again" dialogs the app shows in one run. Kept in memory only: like the other
/// budgets it starts again when ArtCraft is reopened, but unlike `enter_prompts` it must also start
/// again for a window that stays in pod mode across runs, or a provider whose sessions end every
/// hour would lock the person out for good.
pub const MAX_SIGN_IN_AGAIN_PROMPTS: u32 = 6;

/// How long to turn requests away after the `refusals`-th declined dialog since the app started:
/// 5 s, 10 s, 20 s, ... up to five minutes. The cap is reached from the seventh refusal; the
/// allowances (6 enter and 12 storage dialogs) let up to 18 refusals happen, so it is reachable.
pub fn refusal_backoff_ms(refusals: usize) -> u64 {
  let doublings = refusals.saturating_sub(1).min(16) as u32;
  COOLDOWN_MS.saturating_mul(1u64 << doublings).min(MAX_COOLDOWN_MS)
}

/// Why the page says it wants an origin added. A closed set the page names and the app cannot
/// check; it only changes what the dialog says, never what is allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
  /// Reading the person's WebID profile.
  Profile,
  /// Reading or saving the person's files.
  Storage,
  /// The place the person will be asked to sign in (their profile named it).
  SignIn,
  /// ArtCraft's own published identity document.
  AppIdentity,
}

impl Purpose {
  pub fn from_word(word: &str) -> Option<Self> {
    match word {
      "profile" => Some(Self::Profile),
      "storage" => Some(Self::Storage),
      "sign-in" => Some(Self::SignIn),
      "app-identity" => Some(Self::AppIdentity),
      _ => None,
    }
  }

  fn prompt(self, origin: &str) -> Prompt {
    let reloads = "If you allow it, this window will reload.";
    match self {
      Self::Storage => Prompt {
        title: "Connect to another server?",
        message: format!(
          "ArtCraft is asking to connect to:\n\n{origin}\n\n\
Only allow this if it is where your Solid pod or profile lives. ArtCraft cannot check why it \
is being asked. {reloads}"
        ),
        accept: "Allow",
      },
      Self::Profile => Prompt {
        title: "Read your profile from another address?",
        message: format!(
          "ArtCraft's window says it needs to read your Solid profile from:\n\n{origin}\n\n\
Only allow this if it is where your WebID profile lives. ArtCraft cannot check why it is \
being asked. {reloads}"
        ),
        accept: "Allow",
      },
      Self::SignIn => Prompt {
        title: "Sign in at another address?",
        message: format!(
          "ArtCraft's window says your Solid profile named this address as the place you sign in:\n\n{origin}\n\n\
If you allow it, this window will reload, and then your browser will open this address and ask \
you to sign in there, perhaps with your password. ArtCraft cannot check this. Only allow it if \
you recognise it as your Solid provider."
        ),
        accept: "Allow",
      },
      Self::AppIdentity => Prompt {
        title: "Contact ArtCraft's identity document?",
        message: format!(
          "ArtCraft's window says this address publishes ArtCraft's own identity document, which \
your Solid provider reads to recognise ArtCraft:\n\n{origin}\n\n\
It is not where your pod or profile lives, and allowing it is normal when you sign in. ArtCraft \
cannot check this. {reloads}"
        ),
        accept: "Allow",
      },
    }
  }
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
  /// The purpose is not one of the closed set.
  InvalidPurpose,
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
      CommandError::InvalidPurpose => "invalid_purpose",
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
  /// The time before which new confirmations are refused: loaded from the record's
  /// `backoff_until_ms` at start (clamped), then kept here, so it still holds when a write fails.
  cooldown_until_ms: std::sync::atomic::AtomicU64,
  /// "Sign in again" dialogs shown in this run, and how many of them the person declined.
  sign_in_again_prompts: std::sync::atomic::AtomicU32,
  sign_in_again_declines: std::sync::atomic::AtomicU32,
}

impl<D: Dialog, W: Windows, C: Clock, S: Store> Controller<D, W, C, S> {
  pub fn new(dialog: D, windows: W, clock: C, store: S, main_label: &'static str, loopback: Loopback) -> Self {
    let controller = Self {
      dialog,
      windows,
      clock,
      store,
      main_label,
      loopback,
      in_flight: Mutex::new(()),
      cooldown_until_ms: std::sync::atomic::AtomicU64::new(0),
      sign_in_again_prompts: std::sync::atomic::AtomicU32::new(0),
      sign_in_again_declines: std::sync::atomic::AtomicU32::new(0),
    };
    controller.load_backoff();
    controller
  }

  /// Enter pod mode for `issuer`: native confirmation naming it, persist, remember the approval
  /// in memory, rebuild the window. The dialogs are bounded here, not in the page: each is
  /// counted before it opens, a declined issuer is not asked about again, and each refusal grows
  /// the wait before the next dialog (the budget outlives leaving pod mode).
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
    let next = transition::enter_from(&before, issuer, self.loopback)?;
    let origin = next.issuer.clone().unwrap_or_default();
    transition::may_enter(&before, &origin)?;
    self.check_cooldown()?;
    let counted = transition::enter_prompt_shown(&before);
    self.persist(&before, &counted)?;
    let prompt = Prompt {
      title: "Enter Solid pod mode",
      message: format!(
        "ArtCraft was asked to restart this window in Solid pod mode for this address:\n\n{origin}\n\n\
It should be the address of your Solid provider or the site of your WebID; ArtCraft cannot check \
that. In pod mode ArtCraft loads no analytics and may only contact that address, the addresses \
you approve later, and ArtCraft's own services. Only continue if you just entered it in \
ArtCraft's settings and trust it."
      ),
      accept: "Enter pod mode",
    };
    match self.ask(&prompt).await {
      Confirmation::Accepted => {
        let next = transition::enter_from(&counted, &origin, self.loopback)?;
        self.persist(&counted, &next)?;
        self.store.set_fresh(Some(origin));
        self.rebuilt().await?;
        Ok(Reply::Applied)
      }
      Confirmation::Declined => {
        self.store.set_fresh(None);
        let mut declined = transition::issuer_declined(&counted, &origin);
        let ms = refusal_backoff_ms(transition::declines(&declined));
        self.wait(&mut declined, ms);
        self.persist(&counted, &declined)?;
        Ok(Reply::Declined)
      }
      Confirmation::TooFast => {
        self.store.set_fresh(None);
        let mut waiting = counted.clone();
        self.wait(&mut waiting, COOLDOWN_MS);
        let _ = self.persist(&counted, &waiting);
        Ok(Reply::TooFast)
      }
    }
  }

  /// Sign in again in a pod window whose session ended (a token that can no longer be renewed
  /// without the person). The window keeps its mode, its issuer and its storage origins: nothing
  /// is added to what it may contact. A native dialog names the recorded issuer, and on Allow the
  /// rebuilt window gets the same one-shot grant a connect leaves (`consume_fresh`), for that
  /// issuer only, so the sign-in still starts from the person's click there. The dialogs are
  /// bounded like the others: counted before each opens, at most `MAX_SIGN_IN_AGAIN_PROMPTS` in a
  /// run, and each refusal grows the wait before the next dialog.
  pub async fn sign_in_again(&self, caller: &str) -> Result<Reply, CommandError> {
    use std::sync::atomic::Ordering::SeqCst;
    self.only_main(caller)?;
    let _turn = self.in_flight.try_lock().map_err(|_| CommandError::Busy)?;
    let before = self.store.record();
    if !before.enabled {
      return Err(CommandError::NotInPodMode);
    }
    // A record with no issuer (a corrupt one, read fail closed) has nothing to sign in to.
    let issuer = before.issuer.clone().ok_or(CommandError::NotInPodMode)?;
    if self.sign_in_again_prompts.load(SeqCst) >= MAX_SIGN_IN_AGAIN_PROMPTS {
      return Err(CommandError::TooManyPrompts);
    }
    self.check_cooldown()?;
    self.sign_in_again_prompts.fetch_add(1, SeqCst);
    let prompt = Prompt {
      title: "Sign in to your Solid pod again",
      message: format!(
        "ArtCraft's window says your Solid pod sign-in has ended and asks to sign you in again at:\n\n{origin}\n\n\
This is the address this window is already in pod mode for; nothing is added to what it may \
contact. If you allow it, this window will reload, and your browser opens there only after you \
continue in the window. ArtCraft cannot check why it is being asked. Only allow it if you just \
chose to sign in again.",
        origin = issuer
      ),
      accept: "Sign in again",
    };
    match self.ask(&prompt).await {
      Confirmation::Accepted => {
        if self.store.record() != before {
          return Err(CommandError::Changed);
        }
        self.store.set_fresh(Some(issuer));
        self.rebuilt().await?;
        Ok(Reply::Applied)
      }
      Confirmation::Declined => {
        self.store.set_fresh(None);
        let declines = self.sign_in_again_declines.fetch_add(1, SeqCst) as usize + 1;
        let mut waiting = before.clone();
        self.wait(&mut waiting, refusal_backoff_ms(transition::declines(&before) + declines));
        let _ = self.persist(&before, &waiting);
        Ok(Reply::Declined)
      }
      Confirmation::TooFast => {
        self.store.set_fresh(None);
        let mut waiting = before.clone();
        self.wait(&mut waiting, COOLDOWN_MS);
        let _ = self.persist(&before, &waiting);
        Ok(Reply::TooFast)
      }
    }
  }

  /// Admit one more origin: same pattern, so the origin is only ever added after a native dialog
  /// that names it. An origin already admitted, or the issuer's own, needs no dialog. The limits
  /// live here, not in the page, because a compromised page can call this command directly: an
  /// origin the person declined is never shown again in this pod-mode session, the app shows a
  /// fixed number of dialogs in all (counted before each opens and persisted; leaving does not
  /// reset it), and each refusal grows the wait before the next dialog (persisted as a deadline).
  /// The dialog says only what the app knows: that the window asked, what it says the reason is
  /// (`purpose`, which the app cannot check), and that the window reloads.
  pub async fn add_storage_origin(&self, caller: &str, origin: &str, purpose: Purpose) -> Result<Reply, CommandError> {
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
    let prompt = purpose.prompt(&shown);
    match self.ask(&prompt).await {
      Confirmation::Accepted => {
        let next = transition::add_storage_origin(&counted, &shown, self.loopback)?;
        self.persist(&counted, &next)?;
        // The origin the person just allowed, in this process: the rebuilt window may offer to
        // resume a sign-in this approval interrupted. It still needs their click, and only the
        // page's own pending hint for exactly this origin turns it into one; without that hint
        // the window just restores its session. A later decline or too-fast answer clears it.
        self.store.set_fresh(Some(shown));
        self.rebuilt().await?;
        Ok(Reply::Applied)
      }
      Confirmation::Declined => {
        self.store.set_fresh(None);
        let mut next = transition::refused(&counted, &shown);
        let ms = refusal_backoff_ms(transition::declines(&next));
        self.wait(&mut next, ms);
        self.persist(&counted, &next)?;
        Ok(Reply::Declined)
      }
      Confirmation::TooFast => {
        self.store.set_fresh(None);
        let mut waiting = counted.clone();
        self.wait(&mut waiting, COOLDOWN_MS);
        let _ = self.persist(&counted, &waiting);
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

  /// The time before which no dialog is shown: the later of the in-memory wait and the record's
  /// deadline, each capped at `MAX_COOLDOWN_MS` from now so that a clock set back, or a record
  /// edited to hold a far-future time, cannot lock dialogs out for longer than the cap.
  fn waiting_until(&self) -> u64 {
    use std::sync::atomic::Ordering::SeqCst;
    let cap = self.clock.now_ms().saturating_add(MAX_COOLDOWN_MS);
    self.cooldown_until_ms.load(SeqCst).min(cap)
  }

  /// Takes the persisted deadline into memory, once, at start: clamped to `MAX_COOLDOWN_MS` from
  /// now, so a record edited to hold a far-future time cannot lock dialogs out for longer.
  pub fn load_backoff(&self) {
    use std::sync::atomic::Ordering::SeqCst;
    let cap = self.clock.now_ms().saturating_add(MAX_COOLDOWN_MS);
    self.cooldown_until_ms.store(self.store.record().backoff_until_ms.min(cap), SeqCst);
  }

  fn check_cooldown(&self) -> Result<(), CommandError> {
    if self.clock.now_ms() < self.waiting_until() {
      return Err(CommandError::CoolingDown);
    }
    Ok(())
  }

  /// Starts a wait of `ms`: in memory at once (so it holds even when the write fails), and in
  /// `record`, which the caller persists with the rest of the answer.
  fn wait(&self, record: &mut PodModeRecord, ms: u64) {
    use std::sync::atomic::Ordering::SeqCst;
    let until = self.clock.now_ms().saturating_add(ms);
    self.cooldown_until_ms.store(until, SeqCst);
    record.backoff_until_ms = until;
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
    // Counted before the dialog, then the entered record.
    assert_eq!(w.persisted.lock().unwrap().len(), 2);
    assert_eq!(record.enter_prompts, 1);
    assert_eq!(w.fresh.lock().unwrap().as_deref(), Some(ISSUER));
    assert_eq!(w.rebuilds.load(SeqCst), 1);
  }

  #[tokio::test]
  async fn enter_changes_nothing_when_declined_and_the_issuer_is_not_asked_about_again() {
    let (w, c) = world();
    *w.answer.lock().unwrap() = Some((Answer::Declined, 3_000));
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Declined));
    assert!(w.fresh.lock().unwrap().is_none());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
    let record = w.record.lock().unwrap().clone();
    assert!(!record.enabled && record.issuer.is_none());
    assert_eq!((record.enter_prompts, record.declined_issuers.clone()), (1, vec![ISSUER.to_string()]));
    assert!(record.backoff_until_ms > 0);
    // Not even after the wait, and without a dialog.
    w.now.fetch_add(MAX_COOLDOWN_MS + 1, SeqCst);
    let shown = w.prompts.lock().unwrap().len();
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::RefusedOrigin));
    assert_eq!(w.prompts.lock().unwrap().len(), shown);
  }

  #[tokio::test]
  async fn an_enter_that_comes_back_too_fast_is_reported_as_such_starts_a_wait_and_is_not_a_refusal() {
    let (w, c) = world();
    *w.answer.lock().unwrap() = Some((Answer::Accepted, MIN_DIALOG_DISPLAY_MS - 1));
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::TooFast));
    let record = w.record.lock().unwrap().clone();
    assert!(!record.enabled && record.declined_issuers.is_empty());
    // Straight away: turned away without a dialog.
    let shown = w.prompts.lock().unwrap().len();
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::CoolingDown));
    assert_eq!(w.prompts.lock().unwrap().len(), shown);
    // After the wait a considered accept works.
    w.now.fetch_add(COOLDOWN_MS + 1, SeqCst);
    *w.answer.lock().unwrap() = Some((Answer::Accepted, MIN_DIALOG_DISPLAY_MS));
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn the_enter_dialog_says_only_what_the_app_knows() {
    let (w, c) = world();
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
    let text = w.prompts.lock().unwrap()[0].clone();
    assert!(text.contains(ISSUER) && text.contains("cannot check"));
    assert!(!text.contains("which you typed"));
  }

  #[tokio::test]
  async fn the_enter_dialogs_are_bounded_and_leaving_does_not_reset_them() {
    use crate::record::MAX_ENTER_PROMPTS;
    let (w, c) = world();
    *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    for i in 0..MAX_ENTER_PROMPTS {
      w.now.fetch_add(MAX_COOLDOWN_MS + 1, SeqCst);
      assert_eq!(c.enter(MAIN, &format!("https://typo{i}.example")).await, Ok(Reply::Declined));
    }
    w.now.fetch_add(MAX_COOLDOWN_MS + 1, SeqCst);
    let shown = w.prompts.lock().unwrap().len();
    assert_eq!(c.enter(MAIN, "https://another.example").await, Err(CommandError::TooManyPrompts));
    assert_eq!(w.prompts.lock().unwrap().len(), shown);
    // A script that enters (once), leaves and clears without any dialog gains nothing.
    *w.record.lock().unwrap() = PodModeRecord { enter_prompts: MAX_ENTER_PROMPTS - 1, ..PodModeRecord::default() };
    *w.answer.lock().unwrap() = None;
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
    assert_eq!(c.leave(MAIN).await, Ok(Reply::Applied));
    assert_eq!(c.credentials_cleared(MAIN).await, Ok(Reply::Applied));
    assert_eq!(w.record.lock().unwrap().enter_prompts, MAX_ENTER_PROMPTS);
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::TooManyPrompts));
  }

  #[tokio::test]
  async fn a_refused_storage_origin_cools_the_next_dialog_down() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 5_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Declined));
    assert_eq!(c.add_storage_origin(MAIN, "https://other.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    assert_eq!(w.prompts.lock().unwrap().len(), 1);
  }

  #[tokio::test]
  async fn only_the_main_window_may_call_and_nothing_happens_for_others() {
    let (w, c) = world();
    in_pod_mode(&w);
    for caller in ["login", "sora", "", "MAIN", "main "] {
      assert_eq!(c.enter(caller, ISSUER).await, Err(CommandError::Forbidden));
      assert_eq!(c.add_storage_origin(caller, "https://pod.example", Purpose::Storage).await, Err(CommandError::Forbidden));
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
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example; x", Purpose::Storage).await, Err(CommandError::InvalidOrigin));
    assert!(w.prompts.lock().unwrap().is_empty());
  }

  #[tokio::test]
  async fn adding_a_storage_origin_asks_once_and_a_known_origin_needs_no_dialog() {
    let (w, c) = world();
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Err(CommandError::NotInPodMode));
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
    assert!(w.prompts.lock().unwrap()[0].contains("https://pod.example"));
    assert_eq!(w.record.lock().unwrap().storage_origins, ["https://pod.example"]);
    let prompts = w.prompts.lock().unwrap().len();
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
    assert_eq!(w.prompts.lock().unwrap().len(), prompts);
  }

  #[tokio::test]
  async fn an_approved_origin_leaves_the_rebuilt_window_a_one_shot_grant_for_that_origin() {
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::SignIn).await, Ok(Reply::Applied));
    assert_eq!(w.fresh.lock().unwrap().as_deref(), Some("https://pod.example"));
    assert_eq!(c.consume_fresh(MAIN).await.as_deref(), Ok("https://pod.example"));
    assert_eq!(c.consume_fresh(MAIN).await, Err(CommandError::NotFresh));
  }

  #[tokio::test]
  async fn a_later_decline_or_too_fast_answer_clears_a_standing_grant() {
    for answer in [(Answer::Declined, 2_000), (Answer::Accepted, MIN_DIALOG_DISPLAY_MS - 1)] {
      let (w, c) = world();
      in_pod_mode(&w);
      w.fresh.lock().unwrap().replace("https://pod.example".to_string());
      *w.answer.lock().unwrap() = Some(answer);
      let reply = c.add_storage_origin(MAIN, "https://other.example", Purpose::Storage).await;
      assert!(matches!(reply, Ok(Reply::Declined | Reply::TooFast)), "{reply:?}");
      assert!(w.fresh.lock().unwrap().is_none(), "{answer:?}");
    }
  }

  #[tokio::test]
  async fn the_dialog_says_what_the_page_claims_and_for_a_sign_in_where_the_person_will_be_asked_to_sign_in() {
    for (purpose, expected, absent) in [
      (Purpose::SignIn, ["named this address as the place you sign in", "ask you to sign in", "recognise it as your Solid provider"], "identity document"),
      (Purpose::AppIdentity, ["ArtCraft's own identity document", "not where your pod or profile lives", "allowing it is normal"], "sign in there"),
      (Purpose::Profile, ["needs to read your Solid profile", "WebID profile lives", "cannot check"], "sign in there"),
      (Purpose::Storage, ["asking to connect to", "pod or profile lives", "cannot check"], "sign in there"),
    ] {
      let (w, c) = world();
      in_pod_mode(&w);
      assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", purpose).await, Ok(Reply::Applied));
      let text = w.prompts.lock().unwrap()[0].clone();
      assert!(text.contains("https://pod.example") && text.contains("reload"), "{purpose:?}");
      for part in expected {
        assert!(text.contains(part), "{purpose:?}: {part}");
      }
      assert!(!text.contains(absent), "{purpose:?}");
    }
  }

  #[test]
  fn the_purpose_is_a_closed_set_of_words() {
    assert_eq!(Purpose::from_word("profile"), Some(Purpose::Profile));
    assert_eq!(Purpose::from_word("storage"), Some(Purpose::Storage));
    assert_eq!(Purpose::from_word("sign-in"), Some(Purpose::SignIn));
    assert_eq!(Purpose::from_word("app-identity"), Some(Purpose::AppIdentity));
    for word in ["", "Storage", "sign_in", "signin", "anything", "storage "] {
      assert_eq!(Purpose::from_word(word), None, "{word:?}");
    }
  }

  #[tokio::test]
  async fn the_issuer_origin_needs_no_dialog_and_no_rebuild() {
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, ISSUER, Purpose::Storage).await, Ok(Reply::Applied));
    assert!(w.prompts.lock().unwrap().is_empty());
    assert!(w.persisted.lock().unwrap().is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
  }

  #[tokio::test]
  async fn a_declined_storage_origin_is_not_added_and_the_next_ask_is_turned_away_for_a_while() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 3_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://evil.example", Purpose::Storage).await, Ok(Reply::Declined));
    assert!(w.record.lock().unwrap().storage_origins.is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
    assert_eq!(c.add_storage_origin(MAIN, "https://other.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    assert_eq!(w.prompts.lock().unwrap().len(), 1);
  }

  #[tokio::test]
  async fn a_session_shows_a_fixed_number_of_storage_dialogs_in_all_and_then_none() {
    use crate::record::MAX_STORAGE_PROMPTS;
    let (w, c) = world();
    in_pod_mode(&w);
    for i in 0..MAX_STORAGE_PROMPTS {
      assert_eq!(c.add_storage_origin(MAIN, &format!("https://pod{i}.example"), Purpose::Storage).await, Ok(Reply::Applied));
      // Keep the list under its own cap so only the dialog allowance is under test.
      w.record.lock().unwrap().storage_origins.truncate(1);
    }
    let shown = w.prompts.lock().unwrap().len();
    assert_eq!(shown, MAX_STORAGE_PROMPTS as usize);
    assert_eq!(c.add_storage_origin(MAIN, "https://one-more.example", Purpose::Storage).await, Err(CommandError::TooManyPrompts));
    assert_eq!(w.prompts.lock().unwrap().len(), shown, "no dialog past the allowance");
    // An origin that is already admitted still answers, without a dialog.
    let admitted = w.record.lock().unwrap().storage_origins[0].clone();
    assert_eq!(c.add_storage_origin(MAIN, &admitted, Purpose::Storage).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn the_dialog_is_counted_and_saved_before_it_opens_so_quitting_with_it_open_gains_nothing() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.during.lock().unwrap() = Some(Box::new(|w| {
      assert_eq!(w.record.lock().unwrap().storage_prompts, 1);
      assert_eq!(w.persisted.lock().unwrap().last().unwrap().storage_prompts, 1);
    }));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn a_declined_origin_is_remembered_and_never_asked_about_again_this_session() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 3_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://evil.example", Purpose::Storage).await, Ok(Reply::Declined));
    assert_eq!(w.record.lock().unwrap().refused_origins, ["https://evil.example"]);
    // Even a fresh controller reading the persisted record (a relaunch) refuses without a dialog.
    let saved = w.record.lock().unwrap().clone();
    let (w2, c2) = world();
    *w2.record.lock().unwrap() = saved;
    c2.load_backoff();
    assert_eq!(c2.add_storage_origin(MAIN, "https://evil.example", Purpose::Storage).await, Err(CommandError::RefusedOrigin));
    assert!(w2.prompts.lock().unwrap().is_empty());
    // The wait survives the relaunch too (it is a persisted deadline), then another origin may ask.
    assert_eq!(c2.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    w2.now.fetch_add(MAX_COOLDOWN_MS, SeqCst);
    *w2.answer.lock().unwrap() = Some((Answer::Accepted, 2_000));
    assert_eq!(c2.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn each_refusal_doubles_the_wait_before_the_next_dialog() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example", Purpose::Storage).await, Ok(Reply::Declined));
    w.now.fetch_add(COOLDOWN_MS - 1, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://b.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    w.now.fetch_add(2, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://b.example", Purpose::Storage).await, Ok(Reply::Declined));
    // The second wait is twice as long.
    w.now.fetch_add(COOLDOWN_MS + 1, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://c.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    w.now.fetch_add(COOLDOWN_MS, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://c.example", Purpose::Storage).await, Ok(Reply::Declined));
  }

  #[test]
  fn the_back_off_doubles_and_is_capped() {
    assert_eq!(refusal_backoff_ms(0), COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(1), COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(2), 2 * COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(3), 4 * COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(1_000), MAX_COOLDOWN_MS);
    // The cap is reachable: the allowances let 18 refusals happen, and the seventh reaches it.
    assert!(refusal_backoff_ms(6) < MAX_COOLDOWN_MS);
    assert_eq!(refusal_backoff_ms(7), MAX_COOLDOWN_MS);
    assert!(crate::record::MAX_ENTER_PROMPTS + crate::record::MAX_STORAGE_PROMPTS >= 7);
  }

  #[tokio::test]
  async fn an_allow_that_comes_too_fast_is_reported_as_such_and_is_not_a_refusal() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Accepted, MIN_DIALOG_DISPLAY_MS - 1));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::TooFast));
    let record = w.record.lock().unwrap().clone();
    assert!(record.refused_origins.is_empty() && record.storage_origins.is_empty());
    assert_eq!(w.rebuilds.load(SeqCst), 0);
    // After the cool-down a considered Allow for the same origin works.
    w.now.fetch_add(COOLDOWN_MS + 1, SeqCst);
    *w.answer.lock().unwrap() = Some((Answer::Accepted, 2_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn the_dialog_names_only_what_the_app_knows_and_says_the_window_reloads() {
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
    let text = w.prompts.lock().unwrap()[0].clone();
    assert!(text.contains("https://pod.example") && text.contains("reload"));
    assert!(!text.contains("profile points") && !text.contains("comes from your profile"));
  }

  #[tokio::test]
  async fn an_allowed_origin_is_in_the_policy_and_the_script_of_the_rebuilt_window() {
    use crate::{csp::build_pod_mode_csp, host_script::host_init_script};
    let (w, c) = world();
    in_pod_mode(&w);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
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
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Err(CommandError::Changed));
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
        c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await,
        c.leave(MAIN).await,
        c.reload(MAIN).await,
        c.credentials_cleared(MAIN).await,
        c.consume_fresh(MAIN).await.map(|_| Reply::Applied),
        c.sign_in_again(MAIN).await,
      );
      gate.notify_one();
      results
    };
    let (first, (a, b, l, r, cc, f, s)) = tokio::join!(first, second);
    assert_eq!(first, Ok(Reply::Applied));
    for result in [a, b, l, r, cc, f, s] {
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
  async fn leaving_and_connecting_again_keeps_the_counts_and_the_wait_and_drops_the_sessions_refusals() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example", Purpose::Storage).await, Ok(Reply::Declined));
    *w.answer.lock().unwrap() = None;
    assert_eq!(c.leave(MAIN).await, Ok(Reply::Applied));
    assert_eq!(c.credentials_cleared(MAIN).await, Ok(Reply::Applied));
    // The wait still runs: no dialog at all, however the page loops.
    assert_eq!(c.enter(MAIN, ISSUER).await, Err(CommandError::CoolingDown));
    w.now.fetch_add(MAX_COOLDOWN_MS, SeqCst);
    assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
    let record = w.record.lock().unwrap().clone();
    assert_eq!((record.storage_prompts, record.refused_origins.len(), record.enter_prompts), (1, 0, 1));
  }

  #[tokio::test]
  async fn a_dialog_free_leave_and_clear_loop_does_not_reset_the_storage_budget() {
    use crate::record::MAX_STORAGE_PROMPTS;
    let (w, c) = world();
    in_pod_mode(&w);
    w.record.lock().unwrap().storage_prompts = MAX_STORAGE_PROMPTS;
    for _ in 0..3 {
      assert_eq!(c.leave(MAIN).await, Ok(Reply::Applied));
      assert_eq!(c.credentials_cleared(MAIN).await, Ok(Reply::Applied));
      assert_eq!(w.record.lock().unwrap().storage_prompts, MAX_STORAGE_PROMPTS);
      // Back into pod mode by the only way there is: an accepted dialog (counted).
      assert_eq!(c.enter(MAIN, ISSUER).await, Ok(Reply::Applied));
      assert_eq!(w.record.lock().unwrap().storage_prompts, MAX_STORAGE_PROMPTS);
      assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Err(CommandError::TooManyPrompts));
    }
  }

  #[tokio::test]
  async fn the_back_off_is_a_persisted_wall_clock_deadline_clamped_when_read() {
    let (w, c) = world();
    in_pod_mode(&w);
    // A record edited (or a clock moved) so that the deadline is far in the future: at most the cap.
    w.record.lock().unwrap().backoff_until_ms = u64::MAX;
    c.load_backoff();
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    w.now.fetch_add(MAX_COOLDOWN_MS + 1, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://pod.example", Purpose::Storage).await, Ok(Reply::Applied));
    // A decline persists its deadline.
    let (w2, c2) = world();
    in_pod_mode(&w2);
    *w2.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    assert_eq!(c2.add_storage_origin(MAIN, "https://a.example", Purpose::Storage).await, Ok(Reply::Declined));
    let saved = w2.persisted.lock().unwrap().last().unwrap().backoff_until_ms;
    assert_eq!(saved, w2.now.load(SeqCst) + COOLDOWN_MS);
  }

  #[tokio::test]
  async fn a_clock_set_back_cannot_stretch_a_wait_past_the_cap() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example", Purpose::Storage).await, Ok(Reply::Declined));
    w.now.fetch_sub(50_000, SeqCst); // a day would do the same
    *w.answer.lock().unwrap() = None;
    assert_eq!(c.add_storage_origin(MAIN, "https://b.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    w.now.fetch_add(MAX_COOLDOWN_MS + 1, SeqCst);
    assert_eq!(c.add_storage_origin(MAIN, "https://b.example", Purpose::Storage).await, Ok(Reply::Applied));
  }

  #[tokio::test]
  async fn a_decline_whose_write_fails_still_starts_the_wait() {
    let (w, c) = world();
    in_pod_mode(&w);
    *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
    *w.during.lock().unwrap() = Some(Box::new(|w| *w.persist_fails.lock().unwrap() = true));
    assert_eq!(c.add_storage_origin(MAIN, "https://a.example", Purpose::Storage).await, Err(CommandError::PersistFailed));
    *w.persist_fails.lock().unwrap() = false;
    *w.during.lock().unwrap() = None;
    let shown = w.prompts.lock().unwrap().len();
    assert_eq!(c.add_storage_origin(MAIN, "https://b.example", Purpose::Storage).await, Err(CommandError::CoolingDown));
    assert_eq!(w.prompts.lock().unwrap().len(), shown);
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

  mod sign_in_again {
    use super::*;

    #[tokio::test]
    async fn an_allowed_dialog_names_the_recorded_issuer_and_leaves_a_one_shot_grant_for_it() {
      let (w, c) = world();
      in_pod_mode(&w);
      let record = w.record.lock().unwrap().clone();
      assert_eq!(c.sign_in_again(MAIN).await, Ok(Reply::Applied));
      assert!(w.prompts.lock().unwrap()[0].contains(ISSUER));
      assert_eq!(w.rebuilds.load(SeqCst), 1);
      // The mode and the origins the window may contact are as they were.
      assert_eq!(*w.record.lock().unwrap(), record);
      assert_eq!(c.consume_fresh(MAIN).await.as_deref(), Ok(ISSUER));
      assert_eq!(c.consume_fresh(MAIN).await, Err(CommandError::NotFresh));
    }

    #[tokio::test]
    async fn it_needs_a_pod_window_with_an_issuer_and_the_main_window() {
      let (w, c) = world();
      assert_eq!(c.sign_in_again(MAIN).await, Err(CommandError::NotInPodMode));
      // A corrupt record is read as pod mode with no issuer: nothing to sign in to.
      *w.record.lock().unwrap() = crate::record::Loaded::Corrupt.effective();
      assert_eq!(c.sign_in_again(MAIN).await, Err(CommandError::NotInPodMode));
      in_pod_mode(&w);
      assert_eq!(c.sign_in_again("login").await, Err(CommandError::Forbidden));
      assert!(w.prompts.lock().unwrap().is_empty());
      assert!(w.fresh.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn a_decline_or_a_too_fast_answer_grants_nothing_and_starts_a_wait() {
      for answer in [(Answer::Declined, 2_000), (Answer::Accepted, MIN_DIALOG_DISPLAY_MS - 1)] {
        let (w, c) = world();
        in_pod_mode(&w);
        w.fresh.lock().unwrap().replace(ISSUER.to_string());
        *w.answer.lock().unwrap() = Some(answer);
        assert!(matches!(c.sign_in_again(MAIN).await, Ok(Reply::Declined | Reply::TooFast)));
        assert!(w.fresh.lock().unwrap().is_none());
        assert_eq!(w.rebuilds.load(SeqCst), 0);
        assert!(w.record.lock().unwrap().enabled, "declining does not leave pod mode");
        let shown = w.prompts.lock().unwrap().len();
        assert_eq!(c.sign_in_again(MAIN).await, Err(CommandError::CoolingDown));
        assert_eq!(w.prompts.lock().unwrap().len(), shown);
      }
    }

    #[tokio::test]
    async fn each_refusal_waits_longer_than_the_one_before() {
      let (w, c) = world();
      in_pod_mode(&w);
      *w.answer.lock().unwrap() = Some((Answer::Declined, 1_000));
      assert_eq!(c.sign_in_again(MAIN).await, Ok(Reply::Declined));
      let first = w.record.lock().unwrap().backoff_until_ms - w.now.load(SeqCst);
      w.now.fetch_add(first + 1, SeqCst);
      assert_eq!(c.sign_in_again(MAIN).await, Ok(Reply::Declined));
      let second = w.record.lock().unwrap().backoff_until_ms - w.now.load(SeqCst);
      assert!(second > first);
    }

    #[tokio::test]
    async fn the_dialogs_are_bounded_per_run_whatever_the_answers() {
      let (w, c) = world();
      in_pod_mode(&w);
      for _ in 0..MAX_SIGN_IN_AGAIN_PROMPTS {
        w.now.fetch_add(MAX_COOLDOWN_MS + 1, SeqCst);
        assert_eq!(c.sign_in_again(MAIN).await, Ok(Reply::Applied));
      }
      w.now.fetch_add(MAX_COOLDOWN_MS + 1, SeqCst);
      let shown = w.prompts.lock().unwrap().len();
      assert_eq!(c.sign_in_again(MAIN).await, Err(CommandError::TooManyPrompts));
      assert_eq!(w.prompts.lock().unwrap().len(), shown);
    }

    #[tokio::test]
    async fn a_record_that_changed_while_the_dialog_was_open_grants_nothing() {
      let (w, c) = world();
      in_pod_mode(&w);
      *w.during.lock().unwrap() = Some(Box::new(|w| *w.record.lock().unwrap() = PodModeRecord::default()));
      assert_eq!(c.sign_in_again(MAIN).await, Err(CommandError::Changed));
      assert!(w.fresh.lock().unwrap().is_none());
      assert_eq!(w.rebuilds.load(SeqCst), 0);
    }
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
      CommandError::InvalidPurpose,
    ];
    let words: std::collections::HashSet<_> = all.iter().map(CommandError::as_str).collect();
    assert_eq!(words.len(), all.len());
    assert!(words.iter().all(|w| w.chars().all(|c| c.is_ascii_lowercase() || c == '_')));
  }
}
