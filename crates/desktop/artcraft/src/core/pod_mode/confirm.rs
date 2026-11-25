use crate::core::windows::main_window::constants::MAIN_WINDOW_NAME;
use pod_mode::controller::{Answer, Dialog, Prompt};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

/// The native confirmation. The NON-consenting button comes first, which is the default one where
/// the dialog API makes the first button the default (macOS and Windows); only a press of the
/// consenting button by its exact label counts, so Enter, Escape and closing the window all
/// refuse. The dialog is modal to the main window.
pub struct TauriDialog {
  app: AppHandle,
}

impl TauriDialog {
  pub fn new(app: AppHandle) -> Self {
    Self { app }
  }
}

pub const REFUSE_LABEL: &str = "Cancel";

/// Maps the dialog's result to an answer: only the consenting label consents.
pub fn answer_from(result: &MessageDialogResult, accept: &str) -> Answer {
  match result {
    MessageDialogResult::Custom(label) if label == accept => Answer::Accepted,
    _ => Answer::Declined,
  }
}

impl Dialog for TauriDialog {
  async fn confirm(&self, prompt: &Prompt) -> Answer {
    let app = self.app.clone();
    let title = prompt.title.to_string();
    let message = prompt.message.clone();
    let accept = prompt.accept;
    let shown = tauri::async_runtime::spawn_blocking(move || {
      let builder = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(REFUSE_LABEL.to_string(), accept.to_string()));
      let builder = match app.get_webview_window(MAIN_WINDOW_NAME) {
        Some(window) => builder.parent(&window),
        None => builder,
      };
      builder.blocking_show_with_result()
    })
    .await;
    match shown {
      Ok(result) => answer_from(&result, accept),
      Err(_) => Answer::Declined,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_consenting_label_consents() {
    assert_eq!(answer_from(&MessageDialogResult::Custom("Enter pod mode".into()), "Enter pod mode"), Answer::Accepted);
    for result in [
      MessageDialogResult::Custom(REFUSE_LABEL.into()),
      MessageDialogResult::Custom("enter pod mode".into()),
      MessageDialogResult::Ok,
      MessageDialogResult::Yes,
      MessageDialogResult::Cancel,
      MessageDialogResult::No,
    ] {
      assert_eq!(answer_from(&result, "Enter pod mode"), Answer::Declined, "{result:?}");
    }
  }
}
