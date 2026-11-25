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

// default-src and media-src: the static default-src without analytics and without
// 'unsafe-eval'/'unsafe-inline'. Deliberately not `*`, and nothing the static default-src
// lacks: the policy is sent alone, so it must never admit more than the static one.
const HOSTED_CONTENT_SOURCES: &[&str] = &[
  "'self'",
  "blob:",
  "data:",
  "https://*.fakeyou.com",
  "https://*.storyteller.ai",
  "ipc://localhost",
  "tauri://localhost",
];

// img-src: the same, plus the asset host, which the static `img-src *` also covers.
const HOSTED_IMAGE_SOURCES: &[&str] = &[
  "'self'",
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

/// The policy for a restricted window, as the value of the one `Content-Security-Policy` header
/// the app sends (or of a meta element, as defence in depth). It is sent alone, never next to
/// the static policy, because engines differ on repeated headers; the tests prove it admits
/// nothing the static policy does not, except the origins the person approved, which appear
/// only in `connect-src`. Every fetch-type directive is explicit.
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
  let images = HOSTED_IMAGE_SOURCES.join(" ");
  Ok(
    [
      format!("default-src {content}"),
      "script-src 'self' 'wasm-unsafe-eval'".to_string(),
      "worker-src 'self' blob:".to_string(),
      "style-src 'self' 'unsafe-inline'".to_string(),
      "font-src 'self'".to_string(),
      format!("img-src {images}"),
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
  const EXACT: &str = "default-src 'self' blob: data: https://*.fakeyou.com https://*.storyteller.ai ipc://localhost tauri://localhost; \
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; \
img-src 'self' blob: data: https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost ipc://localhost tauri://localhost; \
media-src 'self' blob: data: https://*.fakeyou.com https://*.storyteller.ai ipc://localhost tauri://localhost; \
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

  /// The policy is sent alone, so it must admit nothing the static policy of any build does not,
  /// for every fetch directive, apart from the origins the person approved in `connect-src`.
  #[test]
  fn admits_nothing_the_static_policy_does_not() {
    let approved = vec!["https://pod1.example".to_string(), "https://pod2.example:8443".to_string()];
    let csp = build_pod_mode_csp(Some("https://id.example"), &approved, HttpRefused).unwrap();
    let pod = directives(&csp);
    let extras = ["https://id.example", "https://pod1.example", "https://pod2.example:8443"];
    let mut checked = 0;
    for conf in ["tauri.conf.json", "tauri-mac.conf.json", "tauri-dev-hot-reload.conf.json"] {
      let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop/artcraft").join(conf);
      let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
      let value: serde_json::Value = serde_json::from_str(&text).unwrap();
      let Some(static_csp) = value.pointer("/app/security/csp").and_then(|v| v.as_object()) else { continue };
      checked += 1;
      let static_sources = |name: &str| -> Option<Vec<String>> {
        let v = static_csp.get(name)?;
        Some(match v {
          serde_json::Value::String(s) => s.split(' ').map(str::to_string).collect(),
          serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
          _ => return None,
        })
      };
      let effective = |name: &str| -> Vec<String> {
        let chain: &[&str] = match name {
          "worker-src" => &["worker-src", "child-src", "script-src", "default-src"],
          "frame-src" => &["frame-src", "child-src", "default-src"],
          other => &[other, "default-src"],
        };
        chain.iter().find_map(|n| static_sources(n)).unwrap_or_default()
      };
      for name in FETCH_DIRECTIVES {
        let (_, sources) = pod.iter().find(|(n, _)| n == name).unwrap();
        let allowed = effective(name);
        for token in sources {
          if token == "'none'" || (*name == "connect-src" && extras.contains(&token.as_str())) {
            continue;
          }
          assert!(covered(token, &allowed), "{conf}: {name} admits {token}, the static policy does not");
        }
      }
    }
    assert_eq!(checked, 3, "expected three configs with a static policy");
  }

  /// CSP3 matching for the token kinds these policies use.
  fn covered(token: &str, allowed: &[String]) -> bool {
    if allowed.iter().any(|a| a == token) {
      return true;
    }
    let wildcard = allowed.iter().any(|a| a == "*");
    wildcard && (token == "'self'" || token.starts_with("https://") || token.starts_with("http://"))
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
