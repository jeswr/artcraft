//! Pure logic behind ArtCraft's Solid pod mode. The Tauri app owns the mode: the page can only
//! ask for it, and an origin is trusted only after a native confirmation. No credential ever
//! reaches this crate; it only sees origins.

pub mod csp;
pub mod host_script;
pub mod origin;
pub mod record;
pub mod transition;
