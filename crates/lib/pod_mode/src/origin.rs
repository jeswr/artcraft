use url::Url;

const MAX_ORIGIN_LEN: usize = 255;

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

/// Returns `value` when it is exactly an origin: https (or http for `localhost` and `127.0.0.1`
/// when `loopback` allows it), with a host of `[a-z0-9.-]`. The URL parser's serialised origin
/// must equal `value`, which rejects paths, queries, fragments, userinfo, trailing slashes,
/// default ports, upper case, IPv6 literals, embedded control characters and IDN forms.
pub fn parse_origin(value: &str, loopback: Loopback) -> Option<String> {
  if value.is_empty() || value.len() > MAX_ORIGIN_LEN {
    return None;
  }
  let url = Url::parse(value).ok()?;
  if url.origin().ascii_serialization() != value {
    return None;
  }
  let host = url.host_str()?;
  if host.is_empty() || !host.bytes().all(is_host_byte) {
    return None;
  }
  match url.scheme() {
    "https" => Some(value.to_string()),
    "http" if loopback == Loopback::HttpAllowed && is_loopback_host(host) => Some(value.to_string()),
    _ => None,
  }
}

fn is_host_byte(byte: u8) -> bool {
  byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
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
