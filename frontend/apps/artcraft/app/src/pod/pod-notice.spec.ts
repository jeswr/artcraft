import { beforeEach, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@storyteller/ui-toaster", () => ({ toast }));

import { notifyPodNotice } from "./pod-notice";

beforeEach(() => vi.clearAllMocks());

it("shows a success as a success toast and a problem as an error toast", () => {
  notifyPodNotice({ level: "success", message: "ok" });
  notifyPodNotice({ level: "error", message: "bad" });
  expect(toast.success).toHaveBeenCalledWith("ok");
  expect(toast.error).toHaveBeenCalledWith("bad");
});
