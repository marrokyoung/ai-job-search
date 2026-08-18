import { useCallback, useEffect, useState } from "react";
import type { DesktopSettingsView } from "../shared/ipc-contract.ts";
import { getJobAgentApi, type JobAgentApi } from "./api.ts";
import { AppLayout, type ShellStatus } from "./components/layout.tsx";
import { RouteLink } from "./components/route-link.tsx";
import { hrefs, useRoute, type Route } from "./router.ts";
import { toQueryError } from "./use-query.ts";
import { ApplicationsPage } from "./pages/applications.tsx";
import { DashboardPage } from "./pages/dashboard.tsx";
import { JobsPage } from "./pages/jobs.tsx";
import { ReviewQueuePage } from "./pages/reviews.tsx";
import { SettingsPage } from "./pages/settings.tsx";

export function App() {
  const api = getJobAgentApi();
  if (!api) return <BridgeUnavailable />;
  return <ConnectedApp api={api} />;
}

/**
 * Shown when the preload bridge is missing entirely. Keeps the same status
 * element ids as the normal shell so the startup smoke test reports the
 * failure precisely instead of timing out.
 */
function BridgeUnavailable() {
  return (
    <div className="app-shell">
      <main className="app-main">
        <div className="feedback feedback-error" role="alert">
          <p>
            The application bridge is unavailable, so no data can be loaded.
            Restart the application; if the problem persists, reinstall it.
          </p>
        </div>
        <dl>
          <div>
            <dt>Preload bridge</dt>
            <dd id="bridge-status">unavailable — preload bridge missing</dd>
          </div>
          <div>
            <dt>Automation</dt>
            <dd id="automation-status">unknown</dd>
          </div>
          <div>
            <dt>Local data directory</dt>
            <dd id="data-directory">unknown</dd>
          </div>
        </dl>
      </main>
    </div>
  );
}

function ConnectedApp({ api }: { api: JobAgentApi }) {
  const route = useRoute();
  const [settings, setSettings] = useState<DesktopSettingsView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api.getSettings().then(
      (response) => {
        if (!stale) setSettings(response.settings);
      },
      (error: unknown) => {
        if (!stale) setSettingsError(toQueryError(error).message);
      },
    );
    return () => {
      stale = true;
    };
  }, [api]);

  /** Pages that mutate settings push the validated response back up here so the paused banner and footer stay current. */
  const applySettings = useCallback((next: DesktopSettingsView) => {
    setSettings(next);
    setSettingsError(null);
  }, []);

  const status: ShellStatus = {
    bridge: `available (${Object.keys(api).length} methods, frozen: ${Object.isFrozen(api)})`,
    automation: settingsError
      ? `error: ${settingsError}`
      : settings
        ? settings.automationPaused
          ? "paused"
          : "running"
        : "unknown",
    dataDirectory: settings?.dataDirectory ?? "unknown",
  };

  return (
    <AppLayout route={route} settings={settings} status={status}>
      <PageForRoute route={route} api={api} onSettingsChanged={applySettings} />
    </AppLayout>
  );
}

function PageForRoute({
  route,
  api,
  onSettingsChanged,
}: {
  route: Route;
  api: JobAgentApi;
  onSettingsChanged: (settings: DesktopSettingsView) => void;
}) {
  switch (route.page) {
    case "dashboard":
      return <DashboardPage api={api} />;
    case "jobs":
      return <JobsPage api={api} jobId={route.jobId} />;
    case "applications":
      return <ApplicationsPage api={api} applicationId={route.applicationId} />;
    case "reviews":
      return <ReviewQueuePage api={api} />;
    case "settings":
      return <SettingsPage api={api} onSettingsChanged={onSettingsChanged} />;
    case "not_found":
      return (
        <section aria-labelledby="not-found-heading">
          <h1 id="not-found-heading">Page not found</h1>
          <p>
            There is no page at <code>{route.path}</code>.
          </p>
          <RouteLink href={hrefs.dashboard}>Go to the dashboard</RouteLink>
        </section>
      );
  }
}
