use crate::origin::{Loopback, parse_origin};
use crate::record::{MAX_ENTER_PROMPTS, MAX_STORAGE_ORIGINS, MAX_STORAGE_PROMPTS, PodModeRecord};

#[derive(Debug, PartialEq, Eq)]
pub enum TransitionError {
  InvalidOrigin,
  NotInPodMode,
  InPodMode,
  TooManyStorageOrigins,
  /// The person already declined this origin in this pod-mode session.
  RefusedOrigin,
  /// This pod-mode session has shown its lifetime allowance of storage-origin dialogs.
  TooManyPrompts,
}

/// Enter pod mode for `issuer`, replacing any earlier issuer and storage origins. The caller
/// shows the native confirmation first; this only validates and builds the new record.
pub fn enter(issuer: &str, loopback: Loopback) -> Result<PodModeRecord, TransitionError> {
  enter_from(&PodModeRecord::default(), issuer, loopback)
}

/// As `enter`, from the record the window had: the dialog budget and back-off are carried (a
/// leave and enter must not reset them); the declined storage origins belong to the session that
/// ends and go.
pub fn enter_from(before: &PodModeRecord, issuer: &str, loopback: Loopback) -> Result<PodModeRecord, TransitionError> {
  let issuer = parse_origin(issuer, loopback).ok_or(TransitionError::InvalidOrigin)?;
  Ok(PodModeRecord {
    enabled: true,
    issuer: Some(issuer),
    credentials_may_exist: true,
    ..before.carried()
  })
}

/// Whether an "enter pod mode" dialog may be shown for `issuer` now: not one the person declined,
/// and the allowance of such dialogs is not used up.
pub fn may_enter(record: &PodModeRecord, issuer: &str) -> Result<(), TransitionError> {
  if record.declined_issuers.iter().any(|o| o == issuer) {
    return Err(TransitionError::RefusedOrigin);
  }
  if record.enter_prompts >= MAX_ENTER_PROMPTS {
    return Err(TransitionError::TooManyPrompts);
  }
  Ok(())
}

/// Counts one "enter pod mode" dialog about to be shown. Persisted before the dialog opens.
pub fn enter_prompt_shown(record: &PodModeRecord) -> PodModeRecord {
  PodModeRecord { enter_prompts: record.enter_prompts.saturating_add(1), ..record.clone() }
}

/// Remembers that the person declined to enter pod mode for `issuer`.
pub fn issuer_declined(record: &PodModeRecord, issuer: &str) -> PodModeRecord {
  let mut next = record.clone();
  if !next.declined_issuers.iter().any(|o| o == issuer) && next.declined_issuers.len() < MAX_ENTER_PROMPTS as usize {
    next.declined_issuers.push(issuer.to_string());
  }
  next
}

/// How many dialogs the person has declined since the app started: the back-off grows with it.
pub fn declines(record: &PodModeRecord) -> usize {
  record.declined_issuers.len() + record.refused_origins.len()
}

/// Adds a storage origin to a record that is already in pod mode. Adding one that is present,
/// or the issuer's own origin (always allowed), changes nothing. The origin is validated here
/// (https, or the explicit loopback allowance; a bare origin with no path, wildcard or
/// separator) and the list is capped; the caller shows the native confirmation first.
pub fn add_storage_origin(
  record: &PodModeRecord,
  origin: &str,
  loopback: Loopback,
) -> Result<PodModeRecord, TransitionError> {
  if !record.enabled || record.issuer.is_none() {
    return Err(TransitionError::NotInPodMode);
  }
  let origin = parse_origin(origin, loopback).ok_or(TransitionError::InvalidOrigin)?;
  let mut next = record.clone();
  if next.issuer.as_deref() == Some(origin.as_str()) || next.storage_origins.contains(&origin) {
    return Ok(next);
  }
  if next.storage_origins.len() >= MAX_STORAGE_ORIGINS {
    return Err(TransitionError::TooManyStorageOrigins);
  }
  next.storage_origins.push(origin);
  Ok(next)
}

/// Leaves pod mode: the issuer and storage origins go, the window stops being a pod window, but
/// `credentials_may_exist` STAYS set. The app cannot check that the page wiped its credential
/// store (a compromised page can skip the wipe, and an interruption can stop a real one), so
/// only a later `credentials_cleared`, asked for by a window that is no longer in pod mode after
/// its own wipe reported success, clears the flag. Until then every launch is restricted and
/// finishes the wipe first.
pub fn leave(record: &PodModeRecord) -> Result<PodModeRecord, TransitionError> {
  if !record.enabled {
    return Err(TransitionError::NotInPodMode);
  }
  Ok(PodModeRecord { credentials_may_exist: true, ..record.carried() })
}

/// Whether a dialog may be shown for `origin` now: not one the person already declined, and the
/// session's lifetime allowance of dialogs is not used up. Checked before anything is shown, so a
/// page that calls the command directly gets the same limits as the page's own gate.
pub fn may_prompt(record: &PodModeRecord, origin: &str) -> Result<(), TransitionError> {
  if record.refused_origins.iter().any(|o| o == origin) {
    return Err(TransitionError::RefusedOrigin);
  }
  if record.storage_prompts >= MAX_STORAGE_PROMPTS {
    return Err(TransitionError::TooManyPrompts);
  }
  Ok(())
}

/// Counts one dialog about to be shown. Persisted before the dialog opens.
pub fn prompt_shown(record: &PodModeRecord) -> PodModeRecord {
  PodModeRecord { storage_prompts: record.storage_prompts.saturating_add(1), ..record.clone() }
}

/// Remembers that the person declined `origin`; it is not asked about again in this session.
/// The list holds at most `MAX_STORAGE_PROMPTS` entries, which the prompt allowance never exceeds.
pub fn refused(record: &PodModeRecord, origin: &str) -> PodModeRecord {
  let mut next = record.clone();
  if !next.refused_origins.iter().any(|o| o == origin) && next.refused_origins.len() < MAX_STORAGE_PROMPTS as usize {
    next.refused_origins.push(origin.to_string());
  }
  next
}

/// A successful wipe in a window that is not in pod mode clears the flag. Pod mode itself is
/// never ended this way. This is the only way the flag is cleared.
pub fn credentials_cleared(record: &PodModeRecord) -> Result<PodModeRecord, TransitionError> {
  if record.enabled {
    return Err(TransitionError::InPodMode);
  }
  Ok(PodModeRecord { credentials_may_exist: false, ..record.clone() })
}

#[cfg(test)]
mod tests {
  use super::*;
  use Loopback::HttpRefused;

  #[test]
  fn enter_validates_and_replaces_everything() {
    let record = enter("https://login.example", HttpRefused).unwrap();
    assert_eq!(record.issuer.as_deref(), Some("https://login.example"));
    assert!(record.enabled && record.storage_origins.is_empty());
    assert_eq!(enter("https://login.example/x", HttpRefused), Err(TransitionError::InvalidOrigin));
    assert_eq!(enter("http://login.example", HttpRefused), Err(TransitionError::InvalidOrigin));
  }

  #[test]
  fn storage_origins_need_pod_mode_and_are_bounded() {
    let ordinary = PodModeRecord::default();
    assert_eq!(add_storage_origin(&ordinary, "https://pod.example", HttpRefused), Err(TransitionError::NotInPodMode));
    let mut record = enter("https://login.example", HttpRefused).unwrap();
    record = add_storage_origin(&record, "https://pod.example", HttpRefused).unwrap();
    assert_eq!(add_storage_origin(&record, "https://pod.example", HttpRefused).unwrap(), record);
    assert_eq!(add_storage_origin(&record, "https://pod.example/x", HttpRefused), Err(TransitionError::InvalidOrigin));
    for i in 1..MAX_STORAGE_ORIGINS {
      record = add_storage_origin(&record, &format!("https://pod{i}.example"), HttpRefused).unwrap();
    }
    assert_eq!(
      add_storage_origin(&record, "https://one-more.example", HttpRefused),
      Err(TransitionError::TooManyStorageOrigins),
    );
  }

  #[test]
  fn the_issuers_own_origin_is_never_added_as_a_storage_origin() {
    let record = enter("https://login.example", HttpRefused).unwrap();
    assert_eq!(add_storage_origin(&record, "https://login.example", HttpRefused).unwrap(), record);
  }

  #[test]
  fn hostile_shaped_origins_are_refused_before_they_reach_the_list() {
    let record = enter("https://login.example", HttpRefused).unwrap();
    for origin in [
      "*",
      "https://*.example",
      "http://pod.example",
      "https://pod.example/path",
      "https://pod.example?x=1",
      "https://pod.example#frag",
      "https://user@pod.example",
      "https://pod.example; script-src *",
      "https://pod.example https://other.example",
      "data:text/plain,x",
      "",
    ] {
      assert_eq!(add_storage_origin(&record, origin, HttpRefused), Err(TransitionError::InvalidOrigin), "{origin:?}");
    }
  }

  #[test]
  fn entering_sets_the_credentials_flag_and_a_corrupt_record_takes_no_origins() {
    assert!(enter("https://login.example", HttpRefused).unwrap().credentials_may_exist);
    let corrupt = pod_mode_corrupt();
    assert_eq!(add_storage_origin(&corrupt, "https://pod.example", HttpRefused), Err(TransitionError::NotInPodMode));
  }

  fn pod_mode_corrupt() -> PodModeRecord {
    crate::record::Loaded::Corrupt.effective()
  }

  #[test]
  fn a_wipe_clears_the_flag_only_outside_pod_mode() {
    let flagged = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    assert_eq!(credentials_cleared(&flagged), Ok(PodModeRecord::default()));
    let pod = enter("https://login.example", HttpRefused).unwrap();
    assert_eq!(credentials_cleared(&pod), Err(TransitionError::InPodMode));
  }

  #[test]
  fn leave_drops_the_origins_but_keeps_the_credentials_flag() {
    let mut pod = enter("https://login.example", HttpRefused).unwrap();
    pod = add_storage_origin(&pod, "https://pod.example", HttpRefused).unwrap();
    let left = leave(&pod).unwrap();
    assert_eq!(
      left,
      PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() },
    );
    assert!(left.restricted());
    assert!(crate::record::is_valid(&left, HttpRefused), "the record must survive a restart");
  }

  #[test]
  fn leaving_and_entering_keep_the_dialog_counts_and_the_back_off_but_drop_this_sessions_refusals() {
    let mut pod = enter("https://login.example", HttpRefused).unwrap();
    pod = refused(&prompt_shown(&pod), "https://nope.example");
    pod = issuer_declined(&enter_prompt_shown(&pod), "https://typo.example");
    pod.backoff_until_ms = 99;
    assert_eq!((pod.storage_prompts, pod.refused_origins.len(), pod.enter_prompts, pod.declined_issuers.len()), (1, 1, 1, 1));
    let left = leave(&pod).unwrap();
    assert_eq!((left.storage_prompts, left.refused_origins.len(), left.enter_prompts, left.declined_issuers.len()), (1, 0, 1, 1));
    assert_eq!(left.backoff_until_ms, 99);
    assert!(crate::record::is_valid(&left, HttpRefused));
    let again = enter_from(&left, "https://login.example", HttpRefused).unwrap();
    assert_eq!((again.storage_prompts, again.enter_prompts, again.declined_issuers.len(), again.backoff_until_ms), (1, 1, 1, 99));
    assert!(again.refused_origins.is_empty());
  }

  #[test]
  fn a_declined_issuer_and_a_used_up_allowance_stop_the_next_enter_dialog() {
    let mut record = PodModeRecord::default();
    assert_eq!(may_enter(&record, "https://a.example"), Ok(()));
    record = issuer_declined(&record, "https://a.example");
    assert_eq!(may_enter(&record, "https://a.example"), Err(TransitionError::RefusedOrigin));
    assert_eq!(may_enter(&record, "https://b.example"), Ok(()));
    for _ in 0..MAX_ENTER_PROMPTS {
      record = enter_prompt_shown(&record);
    }
    assert_eq!(may_enter(&record, "https://b.example"), Err(TransitionError::TooManyPrompts));
    assert!(crate::record::is_valid(&record, HttpRefused));
  }

  #[test]
  fn the_app_starting_outside_pod_mode_starts_the_budget_again_but_not_inside() {
    let mut pod = enter("https://login.example", HttpRefused).unwrap();
    pod = prompt_shown(&pod);
    assert_eq!(pod.clone().budget_reset_on_start(), pod);
    let left = leave(&pod).unwrap();
    assert_eq!(left.budget_reset_on_start(), PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() });
  }

  #[test]
  fn a_refused_origin_and_a_used_up_allowance_stop_the_next_dialog() {
    let mut pod = enter("https://login.example", HttpRefused).unwrap();
    assert_eq!(may_prompt(&pod, "https://a.example"), Ok(()));
    pod = refused(&pod, "https://a.example");
    assert_eq!(may_prompt(&pod, "https://a.example"), Err(TransitionError::RefusedOrigin));
    assert_eq!(may_prompt(&pod, "https://b.example"), Ok(()));
    for _ in 0..MAX_STORAGE_PROMPTS {
      pod = prompt_shown(&pod);
    }
    assert_eq!(may_prompt(&pod, "https://b.example"), Err(TransitionError::TooManyPrompts));
  }

  #[test]
  fn the_refused_list_never_outgrows_what_a_record_may_hold() {
    let mut pod = enter("https://login.example", HttpRefused).unwrap();
    for i in 0..(MAX_STORAGE_PROMPTS * 2) {
      pod = refused(&pod, &format!("https://n{i}.example"));
    }
    assert_eq!(pod.refused_origins.len(), MAX_STORAGE_PROMPTS as usize);
    assert!(crate::record::is_valid(&pod, HttpRefused));
  }

  #[test]
  fn leave_needs_pod_mode_so_it_can_never_raise_the_flag_in_an_ordinary_window() {
    assert_eq!(leave(&PodModeRecord::default()), Err(TransitionError::NotInPodMode));
    let flagged = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    assert_eq!(leave(&flagged), Err(TransitionError::NotInPodMode));
  }

  #[test]
  fn only_the_wipe_confirmation_after_a_leave_reaches_the_ordinary_record() {
    let pod = enter("https://login.example", HttpRefused).unwrap();
    let left = leave(&pod).unwrap();
    assert_eq!(credentials_cleared(&left), Ok(PodModeRecord::default()));
  }
}
