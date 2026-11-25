use url::Url;

const MAX_ORIGIN_LEN: usize = 255;
const MAX_HOST_LEN: usize = 253;
const MAX_LABEL_LEN: usize = 63;

/// Whether `http` is accepted for `localhost` and `127.0.0.1`. Release builds refuse it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loopback {
  HttpAllowed,
  HttpRefused,
}

impl Loopback {
  /// Debug builds may talk to a local server; release builds may not.
  pub fn for_this_build() -> Self {
    if cfg!(debug_assertions) { Self::HttpAllowed } else { Self::HttpRefused }
  }
}

/// Returns `value` when it is exactly an origin that a CSP host source can name: https, with a
/// public DNS-style host. The URL parser's serialised origin must equal `value`, which rejects
/// paths, queries, fragments, userinfo, trailing slashes, default ports, upper case, IPv6
/// literals, embedded control characters and Unicode (IDN) forms. The host must have at least two
/// labels of `[a-z0-9-]` (no empty label, so no trailing dot; none starting or ending with `-`;
/// none starting with `xn--`, so a punycode name is never shown raw), and its last label must
/// not be all digits, which refuses every IPv4 literal. `localhost` and `127.0.0.1`, over https
/// or http, are accepted only when `loopback` allows it. The TypeScript twin
/// (`frontend/libs/pod-mode/src/lib/origins.ts`) follows the same rules; both are tested against
/// `testdata/origin-vectors.json`.
pub fn parse_origin(value: &str, loopback: Loopback) -> Option<String> {
  if value.is_empty() || value.len() > MAX_ORIGIN_LEN {
    return None;
  }
  let url = Url::parse(value).ok()?;
  if url.origin().ascii_serialization() != value {
    return None;
  }
  let host = url.host_str()?;
  if is_loopback_host(host) {
    return (loopback == Loopback::HttpAllowed && matches!(url.scheme(), "https" | "http")).then(|| value.to_string());
  }
  if url.scheme() == "https" && is_public_dns_host(host) { Some(value.to_string()) } else { None }
}

fn is_public_dns_host(host: &str) -> bool {
  if host.len() > MAX_HOST_LEN {
    return false;
  }
  let labels: Vec<&str> = host.split('.').collect();
  labels.len() >= 2 && labels.iter().all(|label| is_dns_label(label)) && !labels[labels.len() - 1].bytes().all(|b| b.is_ascii_digit())
}

fn is_dns_label(label: &str) -> bool {
  !label.is_empty()
    && label.len() <= MAX_LABEL_LEN
    && !label.starts_with('-')
    && !label.ends_with('-')
    && !label.starts_with("xn--")
    && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_loopback_host(host: &str) -> bool {
  host == "localhost" || host == "127.0.0.1"
}

#[cfg(test)]
mod tests {
  use super::*;
  use Loopback::{HttpAllowed, HttpRefused};

  const ACCEPTED: &[&str] = &[
    "https://login.example",
    "https://login.example:8443",
    "https://a-b.c1.example",
  ];

  const REFUSED: &[&str] = &[
    "",
    "login.example",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://login.example",
    "http://login.example",
    "https://login.example/",
    "https://login.example/path",
    "https://login.example?x=1",
    "https://login.example#x",
    "https://user:secret@login.example",
    "https://login.example@evil.example",
    "https://login.example:443",
    "https://LOGIN.example",
    "https://login.example\n.evil.example",
    "https://login.example\u{0}",
    " https://login.example",
    "https://[::1]",
    "https://b\u{fc}cher.example",
    "https://exa_mple.example",
  ];

  #[test]
  fn accepts_bare_https_origins() {
    for value in ACCEPTED {
      assert_eq!(parse_origin(value, HttpRefused), Some(value.to_string()), "{value}");
    }
  }

  #[test]
  fn refuses_everything_that_is_not_exactly_an_origin() {
    for value in REFUSED {
      assert_eq!(parse_origin(value, HttpAllowed), None, "{value:?}");
    }
  }

  #[test]
  fn refuses_overlong_values() {
    let host = "a".repeat(250);
    assert_eq!(parse_origin(&format!("https://{host}.example"), HttpAllowed), None);
  }

  #[derive(serde::Deserialize)]
  struct Vector {
    origin: String,
    valid_release: bool,
    valid_dev: bool,
  }

  #[test]
  fn every_shared_vector_gets_the_same_answer_as_the_typescript_twin() {
    let file: serde_json::Value = serde_json::from_str(include_str!("../testdata/origin-vectors.json")).unwrap();
    let vectors: Vec<Vector> = serde_json::from_value(file["vectors"].clone()).unwrap();
    assert!(vectors.len() > 40);
    for v in vectors {
      assert_eq!(parse_origin(&v.origin, HttpRefused).is_some(), v.valid_release, "release: {:?}", v.origin);
      assert_eq!(parse_origin(&v.origin, HttpAllowed).is_some(), v.valid_dev, "dev: {:?}", v.origin);
      if v.valid_dev {
        assert_eq!(parse_origin(&v.origin, HttpAllowed).as_deref(), Some(v.origin.as_str()));
      }
    }
  }

  #[test]
  fn loopback_http_needs_the_flag() {
    assert_eq!(parse_origin("http://localhost:3000", HttpRefused), None);
    assert_eq!(parse_origin("http://127.0.0.1:3000", HttpRefused), None);
    assert!(parse_origin("http://localhost:3000", HttpAllowed).is_some());
    assert!(parse_origin("http://127.0.0.1:3000", HttpAllowed).is_some());
    assert_eq!(parse_origin("http://192.168.0.1", HttpAllowed), None);
    assert_eq!(parse_origin("http://login.example", HttpAllowed), None);
  }
}
