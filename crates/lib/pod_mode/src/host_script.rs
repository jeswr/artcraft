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
/// present. `header_policy` says the narrowing CSP is added to this document's response header.
/// Values come from a validated record and are JSON-escaped, so no origin can end the script.
pub fn host_init_script(record: &PodModeRecord, header_policy: bool, identifier: &str) -> String {
  let mut value = Map::new();
  value.insert("enabled".into(), json!(record.enabled));
  if record.enabled {
    if let Some(issuer) = &record.issuer {
      value.insert("issuer".into(), json!(issuer));
    }
  }
  let storage: &[String] = if record.enabled { &record.storage_origins } else { &[] };
  value.insert("storageOrigins".into(), json!(storage));
  value.insert("headerPolicy".into(), json!(record.enabled && header_policy));
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
    }
  }

  #[test]
  fn a_pod_window_gets_the_origins_and_the_header_flag() {
    let script = host_init_script(&enabled(), true, ID);
    assert!(script.contains(HOST_GLOBAL));
    assert!(script.contains(r#""enabled":true"#));
    assert!(script.contains(r#""issuer":"https://login.example""#));
    assert!(script.contains(r#""storageOrigins":["https://pod.example"]"#));
    assert!(script.contains(r#""headerPolicy":true"#));
  }

  #[test]
  fn the_global_cannot_be_changed_or_redefined() {
    let script = host_init_script(&enabled(), true, ID);
    assert!(script.contains("writable:false"));
    assert!(script.contains("configurable:false"));
    assert!(script.contains("Object.freeze"));
    assert!(script.contains("hasOwnProperty"));
  }

  #[test]
  fn an_ordinary_window_is_told_so_and_carries_no_origins_or_header_claim() {
    let script = host_init_script(&PodModeRecord::default(), true, ID);
    assert!(script.contains(r#""enabled":false"#));
    assert!(script.contains(r#""headerPolicy":false"#));
    assert!(!script.contains("issuer"));
    // Even a record that still lists origins reveals none when it is not enabled.
    let stale = PodModeRecord { enabled: false, issuer: Some("https://x.example".into()), storage_origins: vec!["https://y.example".into()] };
    let script = host_init_script(&stale, true, ID);
    assert!(!script.contains("x.example") && !script.contains("y.example"));
  }

  #[test]
  fn the_identifier_is_a_read_only_global_and_cannot_break_out() {
    let script = host_init_script(&PodModeRecord::default(), false, ID);
    assert!(script.contains(IDENTIFIER_GLOBAL));
    assert!(script.contains(r#"value:"ai.artcraft.app.dev""#));
    let hostile = host_init_script(&PodModeRecord::default(), false, "a</script>\u{2028}\"b");
    assert!(!hostile.contains('<') && !hostile.contains('\u{2028}'));
  }

  #[test]
  fn the_header_flag_is_false_when_no_header_is_added() {
    assert!(host_init_script(&enabled(), false, ID).contains(r#""headerPolicy":false"#));
  }

  #[test]
  fn nothing_can_close_a_script_element_or_break_a_string() {
    let hostile = PodModeRecord {
      enabled: true,
      issuer: Some("https://a.example</script><script>alert(1)//\u{2028}".into()),
      storage_origins: vec![],
    };
    let script = host_init_script(&hostile, false, ID);
    assert!(!script.contains('<'));
    assert!(!script.contains('\u{2028}'));
  }
}
