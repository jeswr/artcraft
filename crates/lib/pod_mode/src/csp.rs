use crate::origin::{Loopback, parse_origin};

/// Sources the static CSP admits in `connect-src`, minus the analytics hosts, which pod mode
/// never loads. Kept equal to `HOSTED_CONNECT_SOURCES` in `frontend/libs/pod-mode`.
pub const HOSTED_CONNECT_SOURCES: &[&str] = &[
  "asset:",
  "blob:",
  "data:",
  "http://ipc.localhost",
  "https://*.fakeyou.com",
  "https://*.storyteller.ai",
  "https://asset.localhost",
  "https://unpkg.com/detect-gpu@5.0.70/",
  "ipc://localhost",
  "tauri://localhost",
];

// default-src, img-src and media-src: the static default-src without analytics and without
// 'unsafe-eval'/'unsafe-inline', plus the asset protocol. Deliberately not `*`.
const HOSTED_CONTENT_SOURCES: &[&str] = &[
  "'self'",
  "asset:",
  "blob:",
  "data:",
  "https://*.fakeyou.com",
  "https://*.storyteller.ai",
  "https://asset.localhost",
  "ipc://localhost",
  "tauri://localhost",
];

#[derive(Debug, PartialEq, Eq)]
pub enum CspError {
  InvalidIssuer,
  InvalidStorageOrigin,
}

/// The narrowing policy for pod mode, as the value of a `Content-Security-Policy` header or
/// meta element. Added next to the static policy it can only restrict. Every fetch-type
/// directive is explicit, and the issuer and storage origins appear only in `connect-src`.
/// Origins are re-validated here, so a value that is not exactly an origin cannot reach the
/// policy text.
pub fn build_pod_mode_csp(
  issuer: Option<&str>,
  storage_origins: &[String],
  loopback: Loopback,
) -> Result<String, CspError> {
  let mut connect: Vec<String> = vec!["'self'".to_string()];
  connect.extend(HOSTED_CONNECT_SOURCES.iter().map(|s| s.to_string()));
  if let Some(issuer) = issuer {
    let origin = parse_origin(issuer, loopback).ok_or(CspError::InvalidIssuer)?;
    push_unique(&mut connect, origin);
  }
  for storage in storage_origins {
    let origin = parse_origin(storage, loopback).ok_or(CspError::InvalidStorageOrigin)?;
    push_unique(&mut connect, origin);
  }
  let content = HOSTED_CONTENT_SOURCES.join(" ");
  Ok(
    [
      format!("default-src {content}"),
      "script-src 'self' 'wasm-unsafe-eval'".to_string(),
      "worker-src 'self' blob:".to_string(),
      "style-src 'self' 'unsafe-inline'".to_string(),
      "font-src 'self' data:".to_string(),
      format!("img-src {content}"),
      format!("media-src {content}"),
      "object-src 'none'".to_string(),
      "base-uri 'self'".to_string(),
      "form-action 'none'".to_string(),
      "frame-src 'none'".to_string(),
      format!("connect-src {}", connect.join(" ")),
    ]
    .join("; "),
  )
}

fn push_unique(list: &mut Vec<String>, value: String) {
  if !list.contains(&value) {
    list.push(value);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use Loopback::{HttpAllowed, HttpRefused};

  // The one exact snapshot, identical to the TypeScript builder's: a security policy.
  const EXACT: &str = "default-src 'self' asset: blob: data: https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost ipc://localhost tauri://localhost; \
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; \
img-src 'self' asset: blob: data: https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost ipc://localhost tauri://localhost; \
media-src 'self' asset: blob: data: https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost ipc://localhost tauri://localhost; \
object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; \
connect-src 'self' asset: blob: data: http://ipc.localhost https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost \
https://unpkg.com/detect-gpu@5.0.70/ ipc://localhost tauri://localhost https://id.example https://pod.example";

  const FETCH_DIRECTIVES: &[&str] = &[
    "default-src",
    "script-src",
    "worker-src",
    "style-src",
    "font-src",
    "img-src",
    "media-src",
    "connect-src",
  ];

  const HOSTILE: &[&str] = &[
    "https://a.example; script-src *",
    "https://a.example, https://b.example",
    "https://a.example'",
    "https://a.example/path",
    "https://a.example b",
  ];

  #[test]
  fn matches_the_typescript_policy_exactly() {
    let storage = vec!["https://pod.example".to_string()];
    assert_eq!(build_pod_mode_csp(Some("https://id.example"), &storage, HttpRefused).unwrap(), EXACT);
  }

  #[test]
  fn every_fetch_directive_is_explicit_and_none_is_wide() {
    let csp = build_pod_mode_csp(Some("https://id.example"), &[], HttpRefused).unwrap();
    let d = directives(&csp);
    for name in FETCH_DIRECTIVES {
      let sources = d.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("{name} missing"));
      for bad in ["*", "https:", "'unsafe-eval'"] {
        assert!(!sources.1.contains(&bad.to_string()), "{name} has {bad}");
      }
    }
    let script = d.iter().find(|(n, _)| n == "script-src").unwrap();
    assert!(!script.1.contains(&"'unsafe-inline'".to_string()));
  }

  #[test]
  fn names_no_analytics_or_font_host() {
    let csp = build_pod_mode_csp(Some("https://id.example"), &[], HttpRefused).unwrap();
    for bad in ["clarity", "google-analytics", "googletagmanager", "googleapis", "gstatic"] {
      assert!(!csp.contains(bad), "{bad}");
    }
  }

  #[test]
  fn origins_go_into_connect_src_only_and_are_deduplicated() {
    let storage = vec!["https://pod.example".to_string(), "https://id.example".to_string()];
    let csp = build_pod_mode_csp(Some("https://id.example"), &storage, HttpRefused).unwrap();
    assert_eq!(csp.matches("https://id.example").count(), 1);
    for (name, sources) in directives(&csp) {
      let mentions = sources.iter().any(|s| s.contains(".example"));
      assert_eq!(mentions, name == "connect-src", "{name}");
    }
  }

  #[test]
  fn refuses_hostile_issuers_and_storage_origins() {
    for value in HOSTILE {
      assert_eq!(build_pod_mode_csp(Some(value), &[], HttpAllowed), Err(CspError::InvalidIssuer), "{value}");
      let storage = vec![value.to_string()];
      assert_eq!(build_pod_mode_csp(None, &storage, HttpAllowed), Err(CspError::InvalidStorageOrigin), "{value}");
    }
  }

  #[test]
  fn loopback_http_follows_the_build_flag() {
    assert!(build_pod_mode_csp(Some("http://localhost:3000"), &[], HttpAllowed).is_ok());
    assert!(build_pod_mode_csp(Some("http://localhost:3000"), &[], HttpRefused).is_err());
  }

  fn directives(csp: &str) -> Vec<(String, Vec<String>)> {
    csp
      .split("; ")
      .map(|d| {
        let mut parts = d.split(' ');
        let name = parts.next().unwrap().to_string();
        (name, parts.map(str::to_string).collect())
      })
      .collect()
  }
}
