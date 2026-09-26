import { Component, type ErrorInfo, type ReactNode } from 'react';
import './ErrorBoundary.css';

// Catches an error while a page renders, so one broken page or widget shows a message inside the
// shell instead of unmounting the whole app to a white screen (2026-09-26: the Overview crashed on
// an API response missing a field, and the entire console went blank). AppShell keys it by the
// route, so moving to another page tries again.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still in the browser console for whoever is debugging.
    console.error('Page failed to render', error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="error-boundary" role="alert">
        <h1 className="error-boundary__title">This page couldn't be shown</h1>
        <p className="error-boundary__text">
          Something went wrong while showing it. Reload the page to try again; if it keeps
          happening, the details are in the browser console.
        </p>
        <button
          type="button"
          className="ds-button ds-button--default"
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      </div>
    );
  }
}
