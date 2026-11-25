use crate::origin::{Loopback, parse_origin};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const RECORD_FILE_NAME: &str = "pod_mode.json";

/// The most storage origins one pod-mode record may hold.
pub const MAX_STORAGE_ORIGINS: usize = 8;

/// The most storage-origin dialogs the app shows between two starts of the app, however they were
/// answered. The count is carried across leaving and entering pod mode (it is cleared only when the
/// app starts outside pod mode), so a page that calls the command directly, or loops leave and
/// `credentials_cleared`, cannot keep asking. An honest sign-in needs at most four of these (the
/// provider, ArtCraft's identity document, the pod's storage and a Type Index elsewhere), so this
/// allows three complete sign-ins, with the declined ones counted, per run of the app.
pub const MAX_STORAGE_PROMPTS: u32 = 12;

/// The most "enter pod mode" dialogs the app shows between two starts of the app. An honest person
/// types an address once, perhaps again after a typing mistake.
pub const MAX_ENTER_PROMPTS: u32 = 6;

/// The persisted pod-mode state. Written only by the app after a native confirmation; the
/// page never writes it. It holds origins, never credentials.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodModeRecord {
  pub enabled: bool,
  pub issuer: Option<String>,
  pub storage_origins: Vec<String>,
  /// Set when pod mode is entered and kept by leaving it; cleared only by a successful wipe
  /// that a window outside pod mode confirms (`credentials_cleared`). While it is set, even an
  /// ordinary window loads no analytics: pod credentials may still be in web storage.
  #[serde(default)]
  pub credentials_may_exist: bool,
  /// How many storage-origin dialogs the app has shown since it started outside pod mode
  /// (counted before the dialog opens, so quitting with it open does not give the page a fresh
  /// one). Kept by leaving and by entering. At most `MAX_STORAGE_PROMPTS`.
  #[serde(default)]
  pub storage_prompts: u32,
  /// Storage origins the person declined in the current pod-mode session. They are never asked
  /// about again in it. Cleared when pod mode is entered anew. At most `MAX_STORAGE_PROMPTS`.
  #[serde(default)]
  pub refused_origins: Vec<String>,
  /// How many "enter pod mode" dialogs the app has shown since it started outside pod mode
  /// (counted before the dialog opens). Kept by leaving. At most `MAX_ENTER_PROMPTS`.
  #[serde(default)]
  pub enter_prompts: u32,
  /// Issuers the person declined to enter pod mode for. Never asked about again until the app is
  /// restarted outside pod mode. Kept by leaving. At most `MAX_ENTER_PROMPTS` entries.
  #[serde(default)]
  pub declined_issuers: Vec<String>,
  /// Wall-clock time (ms since the epoch) before which no dialog is shown: the back-off after a
  /// refusal. It is clamped when read, so a clock change cannot extend it past
  /// `MAX_COOLDOWN_MS` from now. Kept by leaving.
  #[serde(default)]
  pub backoff_until_ms: u64,
}

impl PodModeRecord {
  /// The window must run restricted: pod mode, or credentials that were never confirmed wiped.
  pub fn restricted(&self) -> bool {
    self.enabled || self.credentials_may_exist
  }

  /// The counters that outlive leaving pod mode: they bound dialogs, so leaving must not reset
  /// them. Everything else about the session is dropped.
  pub fn carried(&self) -> PodModeRecord {
    PodModeRecord {
      storage_prompts: self.storage_prompts,
      enter_prompts: self.enter_prompts,
      declined_issuers: self.declined_issuers.clone(),
      backoff_until_ms: self.backoff_until_ms,
      ..PodModeRecord::default()
    }
  }

  /// The app has just started outside pod mode: the dialog budget starts again. (Quitting and
  /// reopening ArtCraft is the documented way to reset it.)
  pub fn budget_reset_on_start(self) -> PodModeRecord {
    if self.enabled {
      return self;
    }
    PodModeRecord { credentials_may_exist: self.credentials_may_exist, ..PodModeRecord::default() }
  }
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
      Loaded::Corrupt => PodModeRecord {
        enabled: true,
        issuer: None,
        storage_origins: Vec::new(),
        credentials_may_exist: true,
        ..PodModeRecord::default()
      },
    }
  }
}

pub fn record_path(dir: &Path) -> PathBuf {
  dir.join(RECORD_FILE_NAME)
}

/// The record's directory for one app identifier, under `base`. A dev build (its own
/// identifier) and a release build never share a record. The identifier is reduced to
/// `[a-z0-9.-]` so it cannot name another path.
pub fn record_dir(base: &Path, identifier: &str) -> PathBuf {
  let clean: String = identifier
    .chars()
    .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' { c } else { '_' })
    .collect();
  let clean = if clean.is_empty() || clean.chars().all(|c| c == '.') { "unknown".to_string() } else { clean };
  base.join("pod_mode").join(clean)
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

/// Writes the record atomically: a temporary file in the same directory, flushed to disk, then
/// renamed. The ordinary record (no pod mode, no credentials flag) removes the file, so "no
/// record" and "ordinary mode" are the same thing.
pub fn save(dir: &Path, record: &PodModeRecord) -> io::Result<()> {
  fs::create_dir_all(dir)?;
  let path = record_path(dir);
  if *record == PodModeRecord::default() {
    return match fs::remove_file(&path) {
      Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
      _ => Ok(()),
    };
  }
  let temporary = dir.join(format!("{RECORD_FILE_NAME}.{}.tmp", std::process::id()));
  let json = serde_json::to_vec(record).map_err(io::Error::other)?;
  let written = (|| {
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&json)?;
    file.sync_all()
  })();
  if let Err(e) = written {
    let _ = fs::remove_file(&temporary);
    return Err(e);
  }
  fs::rename(&temporary, &path)
}

pub fn is_valid(record: &PodModeRecord, loopback: Loopback) -> bool {
  let counters_ok = record.storage_prompts <= MAX_STORAGE_PROMPTS
    && record.enter_prompts <= MAX_ENTER_PROMPTS
    && record.refused_origins.len() <= MAX_STORAGE_PROMPTS as usize
    && record.declined_issuers.len() <= MAX_ENTER_PROMPTS as usize
    && record.refused_origins.iter().all(|s| parse_origin(s, loopback).is_some())
    && record.declined_issuers.iter().all(|s| parse_origin(s, loopback).is_some())
    && !has_duplicates(&record.refused_origins)
    && !has_duplicates(&record.declined_issuers);
  if !record.enabled {
    return record.issuer.is_none() && record.storage_origins.is_empty() && record.refused_origins.is_empty() && counters_ok;
  }
  if !record.credentials_may_exist {
    return false; // pod mode always implies the flag
  }
  let issuer_ok = record.issuer.as_deref().is_some_and(|i| parse_origin(i, loopback).is_some());
  let storage_ok = record.storage_origins.len() <= MAX_STORAGE_ORIGINS
    && record.storage_origins.iter().all(|s| parse_origin(s, loopback).is_some())
    && !has_duplicates(&record.storage_origins);
  issuer_ok && storage_ok && counters_ok
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
  fn saving_the_ordinary_record_removes_the_file() {
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
  fn a_disabled_record_that_still_flags_credentials_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let flagged = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    save(dir.path(), &flagged).unwrap();
    assert_eq!(load(dir.path(), HttpRefused), Loaded::Valid(flagged.clone()));
    assert!(flagged.restricted() && !flagged.enabled);
    assert!(!PodModeRecord::default().restricted());
  }

  #[test]
  fn an_interrupted_disconnect_survives_a_restart_until_a_wipe_is_confirmed() {
    use crate::transition::{credentials_cleared, leave};
    let dir = tempfile::tempdir().unwrap();
    save(dir.path(), &enabled(ISSUER, &[POD])).unwrap();
    let Loaded::Valid(pod) = load(dir.path(), HttpRefused) else { panic!("valid") };
    save(dir.path(), &leave(&pod).unwrap()).unwrap();
    // The app quits here: the next start reads a restricted, finishing record from disk.
    let Loaded::Valid(finishing) = load(dir.path(), HttpRefused) else { panic!("valid") };
    assert!(!finishing.enabled && finishing.credentials_may_exist && finishing.restricted());
    assert!(record_path(dir.path()).exists());
    // Only the confirmed wipe returns the app to the ordinary record, which is "no file".
    save(dir.path(), &credentials_cleared(&finishing).unwrap()).unwrap();
    assert!(!record_path(dir.path()).exists());
  }

  #[test]
  fn an_unreadable_record_is_corrupt_not_absent() {
    let dir = tempfile::tempdir().unwrap();
    // A directory where the file should be: reading it fails with something other than NotFound.
    fs::create_dir(record_path(dir.path())).unwrap();
    assert_eq!(load(dir.path(), HttpRefused), Loaded::Corrupt);
  }

  #[test]
  fn save_goes_through_a_temporary_file_and_leaves_the_old_record_on_failure() {
    let dir = tempfile::tempdir().unwrap();
    save(dir.path(), &enabled(ISSUER, &[])).unwrap();
    // The temporary name is taken by a directory, so the write fails before the rename.
    fs::create_dir(dir.path().join(format!("{RECORD_FILE_NAME}.{}.tmp", std::process::id()))).unwrap();
    assert!(save(dir.path(), &enabled(ISSUER, &[POD])).is_err());
    assert_eq!(load(dir.path(), HttpRefused), Loaded::Valid(enabled(ISSUER, &[])));
  }

  #[test]
  fn the_directory_depends_on_the_identifier_and_cannot_escape() {
    let base = Path::new("/base");
    assert_ne!(record_dir(base, "ai.artcraft.app"), record_dir(base, "ai.artcraft.app.dev"));
    assert_eq!(record_dir(base, "ai.artcraft.app"), Path::new("/base/pod_mode/ai.artcraft.app"));
    for hostile in ["../x", "a/b", "", "..", "A\\B"] {
      let dir = record_dir(base, hostile);
      assert_eq!(dir.parent(), Some(Path::new("/base/pod_mode")), "{hostile}");
    }
  }

  #[test]
  fn pod_mode_without_the_credentials_flag_is_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
      record_path(dir.path()),
      r#"{"enabled":true,"issuer":"https://login.example","storage_origins":[],"credentials_may_exist":false}"#,
    )
    .unwrap();
    assert_eq!(load(dir.path(), HttpRefused), Loaded::Corrupt);
  }

  #[test]
  fn damaged_content_is_corrupt_and_fails_closed() {
    for text in [
      "",
      "{",
      "[]",
      r#"{"enabled":true,"issuer":"javascript:alert(1)","storage_origins":[],"credentials_may_exist":true}"#,
      r#"{"enabled":true,"issuer":null,"storage_origins":[],"credentials_may_exist":true}"#,
      r#"{"enabled":true,"issuer":"https://login.example/x","storage_origins":[],"credentials_may_exist":true}"#,
      r#"{"enabled":true,"issuer":"https://login.example","storage_origins":["https://a.example; x"],"credentials_may_exist":true}"#,
      r#"{"enabled":true,"issuer":"https://login.example","storage_origins":["https://a.example","https://a.example"],"credentials_may_exist":true}"#,
      r#"{"enabled":false,"issuer":"https://login.example","storage_origins":[]}"#,
      r#"{"enabled":true,"issuer":"http://localhost:3000","storage_origins":[],"credentials_may_exist":true}"#,
    ] {
      let dir = tempfile::tempdir().unwrap();
      fs::write(record_path(dir.path()), text).unwrap();
      let loaded = load(dir.path(), HttpRefused);
      assert_eq!(loaded, Loaded::Corrupt, "{text}");
      let effective = loaded.effective();
      assert!(effective.enabled && effective.issuer.is_none() && effective.storage_origins.is_empty());
      assert!(effective.credentials_may_exist);
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
    let record = PodModeRecord { enabled: true, issuer: Some(ISSUER.to_string()), storage_origins: many, credentials_may_exist: true, ..PodModeRecord::default() };
    assert!(!is_valid(&record, HttpRefused));
  }

  fn enabled(issuer: &str, storage: &[&str]) -> PodModeRecord {
    PodModeRecord {
      enabled: true,
      issuer: Some(issuer.to_string()),
      storage_origins: storage.iter().map(|s| s.to_string()).collect(),
      credentials_may_exist: true,
      ..PodModeRecord::default()
    }
  }
}
