use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// A native, blocking confirmation. It runs in the app's own dialog, outside the page, so page
/// script can neither click it nor draw over it. Call from a blocking-capable thread.
pub fn confirm_blocking(app: &AppHandle, title: &str, message: String, accept: &str) -> bool {
  app
    .dialog()
    .message(message)
    .title(title)
    .kind(MessageDialogKind::Warning)
    .buttons(MessageDialogButtons::OkCancelCustom(accept.to_string(), "Cancel".to_string()))
    .blocking_show()
}

pub fn enter_message(origin: &str) -> String {
  format!(
    "ArtCraft will restart this window in Solid pod mode for the sign-in server:\n\n{origin}\n\n\
In pod mode ArtCraft loads no analytics and may only contact that server, the servers you add \
later, and ArtCraft's own services. Only continue if you started this and trust that server."
  )
}

pub fn add_storage_message(origin: &str) -> String {
  format!(
    "Allow this window to contact the Solid storage server:\n\n{origin}\n\n\
Your pod's pages will be able to receive your requests there. Only continue if you started this \
and trust that server."
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn messages_name_the_origin() {
    assert!(enter_message("https://login.example").contains("https://login.example"));
    assert!(add_storage_message("https://pod.example").contains("https://pod.example"));
  }
}
