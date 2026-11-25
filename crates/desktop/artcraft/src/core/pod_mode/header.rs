use crate::core::pod_mode::state::PodModeState;
use pod_mode::csp::build_pod_mode_csp;
use pod_mode::origin::Loopback;
use pod_mode::record::PodModeRecord;
use std::borrow::Cow;
use tauri::http::header::{CONTENT_SECURITY_POLICY, CONTENT_TYPE, HeaderValue};

/// The narrowed policy for `record`, or `None` outside pod mode. A record whose origins no
/// longer validate yields the policy with no origins rather than none (fail closed).
pub fn pod_csp_value(record: &PodModeRecord) -> Option<String> {
  if !record.enabled {
    return None;
  }
  let loopback = Loopback::for_this_build();
  build_pod_mode_csp(record.issuer.as_deref(), &record.storage_origins, loopback)
    .or_else(|_| build_pod_mode_csp(None, &[], loopback))
    .ok()
}

/// Whether the header route is in effect. In a dev build the dev server serves the page, not the
/// app protocol, so `on_web_resource_request` does not cover it and the page falls back to the
/// meta policy.
pub fn header_route_active() -> bool {
  !tauri::is_dev()
}

/// Adds the narrowed policy as a second `Content-Security-Policy` header on HTML responses.
/// Browsers enforce every policy they are given, so this can only restrict the static one.
pub fn append_pod_csp(record: &PodModeRecord, response: &mut tauri::http::Response<Cow<'static, [u8]>>) {
  let Some(value) = pod_csp_value(record) else { return };
  let is_html = response
    .headers()
    .get(CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/html"));
  if !is_html {
    return;
  }
  if let Ok(value) = HeaderValue::from_str(&value) {
    response.headers_mut().append(CONTENT_SECURITY_POLICY, value);
  }
}

pub fn current_csp(state: &PodModeState) -> Option<String> {
  pod_csp_value(&state.record())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn html_response() -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
      .header(CONTENT_TYPE, "text/html; charset=utf-8")
      .header(CONTENT_SECURITY_POLICY, "default-src 'self'")
      .body(Cow::Borrowed(&b""[..]))
      .unwrap()
  }

  #[test]
  fn ordinary_mode_changes_nothing() {
    let mut response = html_response();
    append_pod_csp(&PodModeRecord::default(), &mut response);
    assert_eq!(response.headers().get_all(CONTENT_SECURITY_POLICY).iter().count(), 1);
  }

  #[test]
  fn pod_mode_appends_beside_the_static_policy() {
    let mut response = html_response();
    let record = PodModeRecord { enabled: true, issuer: Some("https://login.example".into()), storage_origins: vec![] };
    append_pod_csp(&record, &mut response);
    let all: Vec<_> = response.headers().get_all(CONTENT_SECURITY_POLICY).iter().collect();
    assert_eq!(all.len(), 2);
    assert!(all[1].to_str().unwrap().contains("https://login.example"));
  }

  #[test]
  fn non_html_is_untouched() {
    let mut response = tauri::http::Response::builder()
      .header(CONTENT_TYPE, "application/javascript")
      .body(Cow::Borrowed(&b""[..]))
      .unwrap();
    let record = PodModeRecord { enabled: true, issuer: None, storage_origins: vec![] };
    append_pod_csp(&record, &mut response);
    assert!(response.headers().get(CONTENT_SECURITY_POLICY).is_none());
  }

  #[test]
  fn a_corrupt_record_still_gets_a_policy_with_no_origins() {
    let record = PodModeRecord { enabled: true, issuer: Some("not an origin".into()), storage_origins: vec![] };
    let csp = pod_csp_value(&record).unwrap();
    assert!(!csp.contains("not an origin"));
  }
}
