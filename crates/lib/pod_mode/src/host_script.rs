use crate::record::PodModeRecord;
use serde_json::{Map, Value, json};

/// The name of the read-only global the script defines. Kept equal to `HOST_POD_MODE_KEY` in
/// `frontend/libs/pod-mode`.
pub const HOST_GLOBAL: &str = "__ARTCRAFT_POD_MODE__";

/// The read-only global that carries the app identifier. The sign-in redirect scheme is derived
/// from it, so a dev overlay (its own identifier) never receives a release build's callback.
pub const IDENTIFIER_GLOBAL: &str = "__ARTCRAFT_APP_IDENTIFIER__";

/// The initialization script for the main window: it runs before any page script and defines a
/// frozen, non-writable, non-configurable global that tells the page which mode it is in. The
/// page can read it but cannot change it, and the browser-side flag is not consulted when it is
/// present. `header_policy` says the pod policy is the response header of this window's
/// documents and scripts. `credentials_may_exist` is true for any restricted window.
/// Values come from a validated record and are JSON-escaped, so no origin can end the script.
pub fn host_init_script(
  record: &PodModeRecord,
  header_policy: bool,
  identifier: &str,
  fresh_connect: Option<&str>,
) -> String {
  let mut value = Map::new();
  value.insert("enabled".into(), json!(record.enabled));
  if record.enabled {
    if let Some(issuer) = &record.issuer {
      value.insert("issuer".into(), json!(issuer));
    }
  }
  let storage: &[String] = if record.enabled { &record.storage_origins } else { &[] };
  value.insert("storageOrigins".into(), json!(storage));
  value.insert("headerPolicy".into(), json!(record.restricted() && header_policy));
  value.insert("credentialsMayExist".into(), json!(record.restricted()));
  // A connect the person approved in a dialog in this process, for exactly this issuer. A record
  // merely loaded from disk never carries it, so it cannot start a fresh sign-in.
  if let (true, Some(issuer), Some(fresh)) = (record.enabled, record.issuer.as_deref(), fresh_connect) {
    if issuer == fresh {
      value.insert("freshConnect".into(), json!(fresh));
    }
  }
  let json = escape_for_script(&Value::Object(value).to_string());
  let identifier = escape_for_script(&Value::String(identifier.to_string()).to_string());
  format!(
    "(function(){{if(Object.prototype.hasOwnProperty.call(window,'{HOST_GLOBAL}'))return;\
var v={json};Object.freeze(v.storageOrigins);\
Object.defineProperty(window,'{HOST_GLOBAL}',{{value:Object.freeze(v),writable:false,configurable:false,enumerable:false}});\
Object.defineProperty(window,'{IDENTIFIER_GLOBAL}',{{value:{identifier},writable:false,configurable:false,enumerable:false}});}})();"
  )
}

fn escape_for_script(json: &str) -> String {
  json.replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
  use super::*;

  const ID: &str = "ai.artcraft.app.dev";

  fn enabled() -> PodModeRecord {
    PodModeRecord {
      enabled: true,
      issuer: Some("https://login.example".into()),
      storage_origins: vec!["https://pod.example".into()],
      credentials_may_exist: true,
      ..PodModeRecord::default()
    }
  }

  #[test]
  fn a_pod_window_gets_the_origins_and_the_header_flag() {
    let script = host_init_script(&enabled(), true, ID, None);
    assert!(script.contains(HOST_GLOBAL));
    assert!(script.contains(r#""enabled":true"#));
    assert!(script.contains(r#""issuer":"https://login.example""#));
    assert!(script.contains(r#""storageOrigins":["https://pod.example"]"#));
    assert!(script.contains(r#""headerPolicy":true"#));
  }

  #[test]
  fn the_global_cannot_be_changed_or_redefined() {
    let script = host_init_script(&enabled(), true, ID, None);
    assert!(script.contains("writable:false"));
    assert!(script.contains("configurable:false"));
    assert!(script.contains("Object.freeze"));
    assert!(script.contains("hasOwnProperty"));
  }

  #[test]
  fn an_ordinary_window_is_told_so_and_carries_no_origins_or_header_claim() {
    let script = host_init_script(&PodModeRecord::default(), true, ID, None);
    assert!(script.contains(r#""enabled":false"#));
    assert!(script.contains(r#""headerPolicy":false"#));
    assert!(!script.contains("issuer"));
    // Even a record that still lists origins reveals none when it is not enabled.
    let stale = PodModeRecord {
      enabled: false,
      issuer: Some("https://x.example".into()),
      storage_origins: vec!["https://y.example".into()],
      credentials_may_exist: false,
      ..PodModeRecord::default()
    };
    let script = host_init_script(&stale, true, ID, None);
    assert!(!script.contains("x.example") && !script.contains("y.example"));
  }

  #[test]
  fn the_identifier_is_a_read_only_global_and_cannot_break_out() {
    let script = host_init_script(&PodModeRecord::default(), false, ID, None);
    assert!(script.contains(IDENTIFIER_GLOBAL));
    assert!(script.contains(r#"value:"ai.artcraft.app.dev""#));
    let hostile = host_init_script(&PodModeRecord::default(), false, "a</script>\u{2028}\"b", None);
    assert!(!hostile.contains('<') && !hostile.contains('\u{2028}'));
  }

  #[test]
  fn a_fresh_connect_is_carried_only_for_the_recorded_issuer_of_a_pod_window() {
    let script = host_init_script(&enabled(), true, ID, Some("https://login.example"));
    assert!(script.contains(r#""freshConnect":"https://login.example""#));
    assert!(!host_init_script(&enabled(), true, ID, None).contains("freshConnect"));
    assert!(!host_init_script(&enabled(), true, ID, Some("https://other.example")).contains("freshConnect"));
    let ordinary = PodModeRecord::default();
    assert!(!host_init_script(&ordinary, true, ID, Some("https://login.example")).contains("freshConnect"));
  }

  #[test]
  fn an_ordinary_window_with_unwiped_credentials_is_flagged_and_restricted() {
    let flagged = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    let script = host_init_script(&flagged, true, ID, None);
    assert!(script.contains(r#""enabled":false"#));
    assert!(script.contains(r#""credentialsMayExist":true"#));
    assert!(script.contains(r#""headerPolicy":true"#));
    let clean = host_init_script(&PodModeRecord::default(), true, ID, None);
    assert!(clean.contains(r#""credentialsMayExist":false"#));
  }

  #[test]
  fn the_header_flag_is_false_when_no_header_is_added() {
    assert!(host_init_script(&enabled(), false, ID, None).contains(r#""headerPolicy":false"#));
  }

  #[test]
  fn nothing_can_close_a_script_element_or_break_a_string() {
    let hostile = PodModeRecord {
      enabled: true,
      issuer: Some("https://a.example</script><script>alert(1)//\u{2028}".into()),
      storage_origins: vec![],
      credentials_may_exist: true,
      ..PodModeRecord::default()
    };
    let script = host_init_script(&hostile, false, ID, None);
    assert!(!script.contains('<'));
    assert!(!script.contains('\u{2028}'));
  }
}
