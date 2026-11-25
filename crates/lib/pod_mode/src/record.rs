use crate::origin::{Loopback, parse_origin};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const RECORD_FILE_NAME: &str = "pod_mode.json";

/// The most storage origins one pod-mode record may hold.
pub const MAX_STORAGE_ORIGINS: usize = 8;

/// The persisted pod-mode state. Written only by the app after a native confirmation; the
/// page never writes it. It holds origins, never credentials.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodModeRecord {
  pub enabled: bool,
  pub issuer: Option<String>,
  pub storage_origins: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
  /// No record: ordinary mode.
  Absent,
  Valid(PodModeRecord),
  /// A record exists but cannot be trusted.
  Corrupt,
}

impl Loaded {
  /// The record to act on. FAIL CLOSED: a corrupt record means pod mode with no origins, so no
  /// analytics load into a window that may hold pod credentials. `leave` still works.
  pub fn effective(self) -> PodModeRecord {
    match self {
      Loaded::Absent => PodModeRecord::default(),
      Loaded::Valid(record) => record,
      Loaded::Corrupt => PodModeRecord { enabled: true, issuer: None, storage_origins: Vec::new() },
    }
  }
}

pub fn record_path(dir: &Path) -> PathBuf {
  dir.join(RECORD_FILE_NAME)
}

/// Reads and re-validates the record. Any unreadable, malformed or invalid content is corrupt.
pub fn load(dir: &Path, loopback: Loopback) -> Loaded {
  let text = match fs::read_to_string(record_path(dir)) {
    Ok(text) => text,
    Err(e) if e.kind() == io::ErrorKind::NotFound => return Loaded::Absent,
    Err(_) => return Loaded::Corrupt,
  };
  match serde_json::from_str::<PodModeRecord>(&text) {
    Ok(record) if is_valid(&record, loopback) => Loaded::Valid(record),
    _ => Loaded::Corrupt,
  }
}

/// Writes the record atomically (temporary file, then rename). A disabled record removes the
/// file, so "no record" and "ordinary mode" are the same thing.
pub fn save(dir: &Path, record: &PodModeRecord) -> io::Result<()> {
  fs::create_dir_all(dir)?;
  let path = record_path(dir);
  if !record.enabled {
    return match fs::remove_file(&path) {
      Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
      _ => Ok(()),
    };
  }
  let temporary = dir.join(format!("{RECORD_FILE_NAME}.tmp"));
  let json = serde_json::to_vec(record).map_err(io::Error::other)?;
  fs::write(&temporary, json)?;
  fs::rename(&temporary, &path)
}

pub fn is_valid(record: &PodModeRecord, loopback: Loopback) -> bool {
  if !record.enabled {
    return record.issuer.is_none() && record.storage_origins.is_empty();
  }
  let issuer_ok = record.issuer.as_deref().is_some_and(|i| parse_origin(i, loopback).is_some());
  let storage_ok = record.storage_origins.len() <= MAX_STORAGE_ORIGINS
    && record.storage_origins.iter().all(|s| parse_origin(s, loopback).is_some())
    && !has_duplicates(&record.storage_origins);
  issuer_ok && storage_ok
}

fn has_duplicates(values: &[String]) -> bool {
  values.iter().enumerate().any(|(i, v)| values[..i].contains(v))
}

#[cfg(test)]
mod tests {
  use super::*;
  use Loopback::{HttpAllowed, HttpRefused};

  const ISSUER: &str = "https://login.example";
  const POD: &str = "https://pod.example";

  #[test]
  fn a_missing_file_is_ordinary_mode() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(load(dir.path(), HttpRefused), Loaded::Absent);
    assert_eq!(load(dir.path(), HttpRefused).effective(), PodModeRecord::default());
  }

  #[test]
  fn a_saved_record_loads_back_the_same() {
    let dir = tempfile::tempdir().unwrap();
    let record = enabled(ISSUER, &[POD]);
    save(dir.path(), &record).unwrap();
    assert_eq!(load(dir.path(), HttpRefused), Loaded::Valid(record));
  }

  #[test]
  fn saving_a_disabled_record_removes_the_file() {
    let dir = tempfile::tempdir().unwrap();
    save(dir.path(), &enabled(ISSUER, &[])).unwrap();
    save(dir.path(), &PodModeRecord::default()).unwrap();
    assert!(!record_path(dir.path()).exists());
    save(dir.path(), &PodModeRecord::default()).unwrap();
  }

  #[test]
  fn save_leaves_no_temporary_file_and_creates_the_directory() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("config");
    save(&nested, &enabled(ISSUER, &[])).unwrap();
    assert_eq!(fs::read_dir(&nested).unwrap().count(), 1);
  }

  #[test]
  fn damaged_content_is_corrupt_and_fails_closed() {
    for text in [
      "",
      "{",
      "[]",
      r#"{"enabled":true,"issuer":"javascript:alert(1)","storage_origins":[]}"#,
      r#"{"enabled":true,"issuer":null,"storage_origins":[]}"#,
      r#"{"enabled":true,"issuer":"https://login.example/x","storage_origins":[]}"#,
      r#"{"enabled":true,"issuer":"https://login.example","storage_origins":["https://a.example; x"]}"#,
      r#"{"enabled":true,"issuer":"https://login.example","storage_origins":["https://a.example","https://a.example"]}"#,
      r#"{"enabled":false,"issuer":"https://login.example","storage_origins":[]}"#,
      r#"{"enabled":true,"issuer":"http://localhost:3000","storage_origins":[]}"#,
    ] {
      let dir = tempfile::tempdir().unwrap();
      fs::write(record_path(dir.path()), text).unwrap();
      let loaded = load(dir.path(), HttpRefused);
      assert_eq!(loaded, Loaded::Corrupt, "{text}");
      let effective = loaded.effective();
      assert!(effective.enabled && effective.issuer.is_none() && effective.storage_origins.is_empty());
    }
  }

  #[test]
  fn loopback_http_is_valid_only_where_the_build_allows_it() {
    let record = enabled("http://localhost:3000", &[]);
    assert!(is_valid(&record, HttpAllowed));
    assert!(!is_valid(&record, HttpRefused));
  }

  #[test]
  fn too_many_storage_origins_are_corrupt() {
    let many: Vec<String> = (0..=MAX_STORAGE_ORIGINS).map(|i| format!("https://pod{i}.example")).collect();
    let record = PodModeRecord { enabled: true, issuer: Some(ISSUER.to_string()), storage_origins: many };
    assert!(!is_valid(&record, HttpRefused));
  }

  fn enabled(issuer: &str, storage: &[&str]) -> PodModeRecord {
    PodModeRecord {
      enabled: true,
      issuer: Some(issuer.to_string()),
      storage_origins: storage.iter().map(|s| s.to_string()).collect(),
    }
  }
}
