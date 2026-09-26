// Adapted from pingdotgg/t3code apps/web/src/components/RenderErrorBoundary.tsx at 57a66608 (MIT).
import { Component, type ReactNode } from "react";

export class RenderErrorBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
