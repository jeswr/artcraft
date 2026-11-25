import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches a failure of the lazy "My pod" panel (its chunk did not load, or it threw) so the
 * gallery does not go blank. Shows a fixed sentence, never the error text, and a way back.
 */
export class PodPanelBoundary extends Component<{ children: ReactNode; frame: (body: ReactNode) => ReactNode; onBack: () => void }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Deliberately nothing: no logging of the error, which may name a pod URL.
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return this.props.frame(
      <div className="flex h-64 items-center justify-center px-6" role="alert">
        <div className="flex max-w-xs flex-col items-center gap-3 text-center text-sm">
          <div className="text-base-fg/70">My pod couldn't be shown</div>
          <div className="text-xs text-base-fg/60">Something went wrong while loading this view. Your pod was not changed.</div>
          <button type="button" className="text-xs text-blue-400 underline hover:text-blue-300" onClick={this.props.onBack}>
            Back to the ArtCraft library
          </button>
        </div>
      </div>,
    );
  }
}
