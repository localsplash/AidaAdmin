export function LoadingScreen({ label = 'Loading' }: { label?: string }) {
  return (
    <main className="status-screen" aria-busy="true">
      <p role="status">{label}…</p>
    </main>
  );
}

export function ErrorScreen({ onRetry }: { onRetry?: () => void }) {
  return (
    <main className="status-screen">
      <h1>Something went wrong</h1>
      <p role="alert">AidaAdmin could not load. Please try again.</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </main>
  );
}

export function ForbiddenScreen() {
  return (
    <main className="status-screen">
      <h1>Access denied</h1>
      <p role="alert">
        Your account is not authorized for AidaAdmin. Contact an administrator if you believe this
        is a mistake.
      </p>
    </main>
  );
}

export function LoginRequiredScreen() {
  return (
    <main className="status-screen">
      <h1>Sign in required</h1>
      <p>Sign in with your platform account to use AidaAdmin.</p>
      {/* Real id /authorize redirect wiring lands in POC phase 2 (issue #8). */}
      <a className="button" href="/api/auth/login">
        Sign in
      </a>
    </main>
  );
}
