import type { Notice } from "@storyteller/pod-session";
import { toast } from "@storyteller/ui-toaster";

/** Shows a session notice as a toast, wherever the person is in the app. */
export function notifyPodNotice(notice: Notice): void {
  if (notice.level === "success") toast.success(notice.message);
  else toast.error(notice.message);
}
