use pod_mode::csp::build_pod_mode_csp;
use pod_mode::origin::Loopback;
use pod_mode::record::PodModeRecord;
use std::borrow::Cow;
use tauri::http::header::{CONTENT_SECURITY_POLICY, HeaderValue};

/// The policy for a restricted window (pod mode, or credentials not yet confirmed wiped), or
/// `None` for an ordinary one. A record whose origins no longer validate gets the policy with no
/// origins rather than none (fail closed).
pub fn pod_csp_value(record: &PodModeRecord) -> Option<String> {
  if !record.restricted() {
    return None;
  }
  let loopback = Loopback::for_this_build();
  build_pod_mode_csp(record.issuer.as_deref(), &record.storage_origins, loopback)
    .or_else(|_| build_pod_mode_csp(None, &[], loopback))
    .ok()
}

/// Whether the page may be told the header policy is in force: only when there is a policy, and
/// the page is served by the app protocol. In a dev run the dev server serves it, no response of
/// ours is touched, and the page falls back to the meta policy.
pub fn header_claim(is_dev: bool, policy: &Option<String>) -> bool {
  !is_dev && policy.is_some()
}

/// Sets the policy as the ONE `Content-Security-Policy` header of a response, replacing whatever
/// was there. Every response of the main window gets it (documents, scripts, workers), and no
/// engine ever has two to reconcile. The policy admits nothing the static one does not (tested
/// in the `pod_mode` crate).
pub fn set_pod_csp(policy: &Option<String>, response: &mut tauri::http::Response<Cow<'static, [u8]>>) {
  let Some(value) = policy else { return };
  if let Ok(value) = HeaderValue::from_str(value) {
    response.headers_mut().insert(CONTENT_SECURITY_POLICY, value);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tauri::http::header::CONTENT_TYPE;

  fn response(content_type: &str) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
      .header(CONTENT_TYPE, content_type)
      .header(CONTENT_SECURITY_POLICY, "default-src 'self' 'unsafe-eval'")
      .body(Cow::Borrowed(&b""[..]))
      .unwrap()
  }

  fn pod() -> PodModeRecord {
    PodModeRecord {
      enabled: true,
      issuer: Some("https://login.example".into()),
      storage_origins: vec![],
      credentials_may_exist: true,
      ..PodModeRecord::default()
    }
  }

  #[test]
  fn an_ordinary_window_gets_no_policy_and_its_responses_are_untouched() {
    let policy = pod_csp_value(&PodModeRecord::default());
    assert_eq!(policy, None);
    let mut r = response("text/html");
    set_pod_csp(&policy, &mut r);
    assert_eq!(r.headers().get_all(CONTENT_SECURITY_POLICY).iter().count(), 1);
    assert!(r.headers().get(CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap().contains("unsafe-eval"));
  }

  #[test]
  fn every_kind_of_response_gets_exactly_one_policy_which_replaces_the_static_one() {
    let policy = pod_csp_value(&pod());
    for content_type in ["text/html; charset=utf-8", "text/javascript", "application/wasm", "image/png", ""] {
      let mut r = response(content_type);
      set_pod_csp(&policy, &mut r);
      let all: Vec<_> = r.headers().get_all(CONTENT_SECURITY_POLICY).iter().collect();
      assert_eq!(all.len(), 1, "{content_type}");
      assert!(all[0].to_str().unwrap().contains("https://login.example"));
      assert!(!all[0].to_str().unwrap().contains("'unsafe-eval'"));
    }
  }

  #[test]
  fn an_ordinary_window_that_may_still_hold_credentials_is_restricted_too() {
    let flagged = PodModeRecord { credentials_may_exist: true, ..PodModeRecord::default() };
    assert!(pod_csp_value(&flagged).is_some());
  }

  #[test]
  fn a_corrupt_record_still_gets_a_policy_with_no_origins() {
    let record = PodModeRecord { issuer: Some("not an origin".into()), ..pod() };
    let csp = pod_csp_value(&record).unwrap();
    assert!(!csp.contains("not an origin"));
  }

  #[test]
  fn the_header_claim_needs_a_policy_and_the_app_protocol() {
    let policy = pod_csp_value(&pod());
    assert!(header_claim(false, &policy));
    assert!(!header_claim(true, &policy));
    assert!(!header_claim(false, &None));
  }
}
