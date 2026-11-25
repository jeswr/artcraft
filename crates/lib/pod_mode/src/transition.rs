use crate::origin::{Loopback, parse_origin};
use crate::record::{MAX_STORAGE_ORIGINS, PodModeRecord};

#[derive(Debug, PartialEq, Eq)]
pub enum TransitionError {
  InvalidOrigin,
  NotInPodMode,
  TooManyStorageOrigins,
}

/// Enter pod mode for `issuer`, replacing any earlier issuer and storage origins. The caller
/// shows the native confirmation first; this only validates and builds the new record.
pub fn enter(issuer: &str, loopback: Loopback) -> Result<PodModeRecord, TransitionError> {
  let issuer = parse_origin(issuer, loopback).ok_or(TransitionError::InvalidOrigin)?;
  Ok(PodModeRecord { enabled: true, issuer: Some(issuer), storage_origins: Vec::new() })
}

/// Adds a storage origin to a record that is already in pod mode. Adding one that is present
/// changes nothing.
pub fn add_storage_origin(
  record: &PodModeRecord,
  origin: &str,
  loopback: Loopback,
) -> Result<PodModeRecord, TransitionError> {
  if !record.enabled {
    return Err(TransitionError::NotInPodMode);
  }
  let origin = parse_origin(origin, loopback).ok_or(TransitionError::InvalidOrigin)?;
  let mut next = record.clone();
  if next.storage_origins.contains(&origin) {
    return Ok(next);
  }
  if next.storage_origins.len() >= MAX_STORAGE_ORIGINS {
    return Err(TransitionError::TooManyStorageOrigins);
  }
  next.storage_origins.push(origin);
  Ok(next)
}

/// Back to ordinary mode.
pub fn leave() -> PodModeRecord {
  PodModeRecord::default()
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
  fn leave_is_the_ordinary_record() {
    assert_eq!(leave(), PodModeRecord::default());
  }
}
