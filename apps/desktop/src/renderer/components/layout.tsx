import type { MouseEvent, ReactNode } from "react";
import type { DesktopSettingsView } from "../../shared/ipc-contract.ts";
import { hrefs, navigate, type Route } from "../router.ts";

const navItems = [
  { page: "dashboard", href: hrefs.dashboard, label: "Dashboard" },
  { page: "jobs", href: hrefs.jobs, label: "Jobs" },
  { page: "applications", href: hrefs.applications, label: "Applications" },
  { page: "reviews", href: hrefs.reviews, label: "Review queue" },
  { page: "settings", href: hrefs.settings, label: "Settings" },
] as const;

export type ShellStatus = {
  bridge: string;
  automation: string;
  dataDirectory: string;
};

/**
 * The persistent application shell: skip link, header banners, primary
 * navigation, main landmark, and the status footer whose element ids
 * (`bridge-status`, `automation-status`, `data-directory`) the Electron
 * startup smoke test reads to prove the preload bridge round trip works.
 */
export function AppLayout({
  route,
  settings,
  status,
  children,
}: {
  route: Route;
  settings: DesktopSettingsView | null;
  status: ShellStatus;
  children: ReactNode;
}) {
  const onSkip = (event: MouseEvent<HTMLAnchorElement>) => {
    // Plain hash navigation would be swallowed by the router; move focus to
    // the main landmark directly instead.
    event.preventDefault();
    document.getElementById("main-content")?.focus();
  };
  const onNavClick = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(href);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={onSkip}>
        Skip to main content
      </a>
      <header className="app-header">
        <p className="app-title">US Job Agent</p>
        <p className="banner banner-synthetic">
          Synthetic data only — Phase 1 makes no live requests or submissions.
        </p>
        {settings?.automationPaused ? (
          <p className="banner banner-paused" role="status">
            Automation is paused. It can be resumed from Settings.
          </p>
        ) : null}
      </header>
      <nav aria-label="Primary" className="app-nav">
        <ul>
          {navItems.map((item) => (
            <li key={item.page}>
              <a
                href={item.href}
                onClick={onNavClick(item.href)}
                aria-current={route.page === item.page ? "page" : undefined}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main-content" tabIndex={-1} className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <dl>
          <div>
            <dt>Preload bridge</dt>
            <dd id="bridge-status">{status.bridge}</dd>
          </div>
          <div>
            <dt>Automation</dt>
            <dd id="automation-status">{status.automation}</dd>
          </div>
          <div>
            <dt>Local data directory</dt>
            <dd id="data-directory">{status.dataDirectory}</dd>
          </div>
        </dl>
      </footer>
    </div>
  );
}
