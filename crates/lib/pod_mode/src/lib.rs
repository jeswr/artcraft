//! Pure logic behind ArtCraft's Solid pod mode. The Tauri app owns the mode: the page can only
//! ask for it, and an origin is trusted only after a native confirmation. No credential ever
//! reaches this crate; it only sees origins.

pub mod controller;
pub mod csp;
pub mod host_script;
pub mod origin;
pub mod rebuild;
pub mod record;
pub mod transition;

/// Whether a window-driven `ExitRequested` must be held back: while the main window is being
/// rebuilt (the last window closing is not a request to quit) or while an update is installing.
/// An explicit exit code is a real quit and is never held back here.
pub fn should_prevent_exit(rebuilding: bool, update_installing: bool, exit_code: Option<i32>) -> bool {
  update_installing || (rebuilding && exit_code.is_none())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_exit_guard_holds_only_while_rebuilding_or_updating() {
    assert!(should_prevent_exit(true, false, None));
    assert!(!should_prevent_exit(false, false, None));
    assert!(should_prevent_exit(false, true, None));
    assert!(should_prevent_exit(false, true, Some(0)));
    assert!(!should_prevent_exit(true, false, Some(0)), "an explicit exit is a real quit");
  }
}
