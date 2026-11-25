use crate::origin::{Loopback, parse_origin};
use crate::record::{MAX_STORAGE_ORIGINS, PodModeRecord};

#[derive(Debug, PartialEq, Eq)]
pub enum TransitionError {
  InvalidOrigin,
  NotInPodMode,
  InPodMode,
  TooManyStorageOrigins,
}

/// Enter pod mode for `issuer`, replacing any earlier issuer and storage origins. The caller
/// shows the native confirmation first; this only validates and builds the new record.
pub fn enter(issuer: &str, loopback: Loopback) -> Result<PodModeRecord, TransitionError> {
  let issuer = parse_origin(issuer, loopback).ok_or(TransitionError::InvalidOrigin)?;
  Ok(PodModeRecord {
    enabled: true,
    issuer: Some(issuer),
    storage_origins: Vec::new(),
    credentials_may_exist: true,
  })
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
  Ok(PodModeRecord { enabled: false, issuer: None, storage_origins: Vec::new(), credentials_may_exist: true })
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
      PodModeRecord { enabled: false, issuer: None, storage_origins: Vec::new(), credentials_may_exist: true },
    );
    assert!(left.restricted());
    assert!(crate::record::is_valid(&left, HttpRefused), "the record must survive a restart");
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
