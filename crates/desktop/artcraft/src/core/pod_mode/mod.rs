//! The app owns Solid pod mode. The page can only ask for a change; the change happens after a
//! native confirmation that names the origin, and the record lives in the app config dir where
//! page script cannot write it. Only origins ever reach this code, never a credential.

pub mod confirm;
pub mod header;
pub mod state;
pub mod window;
