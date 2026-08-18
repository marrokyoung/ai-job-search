import { useId, useState, type FormEvent } from "react";
import { automationModes, type DesktopSettingsView } from "../../shared/ipc-contract.ts";
import type { JobAgentApi } from "../api.ts";
import { QuerySection } from "../components/feedback.tsx";
import { ReasonDialog } from "../components/reason-dialog.tsx";
import { useQuery, toQueryError } from "../use-query.ts";

export function SettingsPage({
  api,
  onSettingsChanged,
}: {
  api: JobAgentApi;
  onSettingsChanged: (settings: DesktopSettingsView) => void;
}) {
  const { state, reload } = useQuery(() => api.getSettings(), [api]);
  return (
    <section aria-labelledby="settings-heading">
      <h1 id="settings-heading">Settings</h1>
      <QuerySection label="settings" state={state} onRetry={reload}>
        {({ settings }) => (
          <SettingsView
            api={api}
            initial={settings}
            onSettingsChanged={onSettingsChanged}
          />
        )}
      </QuerySection>
    </section>
  );
}

function SettingsView({
  api,
  initial,
  onSettingsChanged,
}: {
  api: JobAgentApi;
  initial: DesktopSettingsView;
  onSettingsChanged: (settings: DesktopSettingsView) => void;
}) {
  const modeId = useId();
  const limitId = useId();
  const dangerNoteId = useId();
  const [settings, setSettings] = useState(initial);
  const [defaultMode, setDefaultMode] = useState(initial.defaultMode);
  const [dailyLimit, setDailyLimit] = useState(String(initial.dailyApplicationLimit));
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);

  const applySettings = (next: DesktopSettingsView) => {
    setSettings(next);
    onSettingsChanged(next);
  };

  const onSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = dailyLimit.trim();
    const limit = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(limit) || limit < 0 || limit > 1000) {
      setSaveMessage(null);
      setSaveError("The daily application limit must be a whole number between 0 and 1000.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    api
      .updateSettings({ defaultMode, dailyApplicationLimit: limit })
      .then((response) => {
        applySettings(response.settings);
        setSaveMessage("Settings saved.");
      })
      .catch((error: unknown) => {
        setSaveError(toQueryError(error).message);
      })
      .finally(() => setSaving(false));
  };

  const togglePause = async (reason: string) => {
    const response = await api.setAutomationPaused({
      paused: !settings.automationPaused,
      reason,
    });
    applySettings(response.settings);
    setPauseDialogOpen(false);
  };

  return (
    <div className="settings-sections">
      <section aria-labelledby="automation-defaults-heading">
        <h2 id="automation-defaults-heading">Automation defaults</h2>
        {/* noValidate: the inline role="alert" messages below replace the
            browser's native validation bubbles, which screen readers miss. */}
        <form onSubmit={onSave} className="settings-form" noValidate>
          <div className="form-field">
            <label htmlFor={modeId}>Default automation mode</label>
            <select
              id={modeId}
              value={defaultMode}
              onChange={(event) =>
                setDefaultMode(event.target.value as (typeof automationModes)[number])
              }
            >
              {automationModes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
            <p className="field-hint">
              Manual and assisted modes always require your approval before any
              submission; autonomous mode requires a recorded policy approval.
            </p>
          </div>
          <div className="form-field">
            <label htmlFor={limitId}>Daily application limit</label>
            <input
              id={limitId}
              type="number"
              inputMode="numeric"
              min={0}
              max={1000}
              value={dailyLimit}
              onChange={(event) => setDailyLimit(event.target.value)}
            />
            <p className="field-hint">0 pauses new submissions entirely.</p>
          </div>
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {saveMessage ? (
            <p className="form-success" role="status">
              {saveMessage}
            </p>
          ) : null}
          {saveError ? (
            <p className="form-error" role="alert">
              {saveError}
            </p>
          ) : null}
        </form>
      </section>

      <section aria-labelledby="pause-heading">
        <h2 id="pause-heading">Automation pause</h2>
        <p role="status">
          {settings.automationPaused
            ? "Automation is paused. No automated submissions can occur."
            : "Automation is running."}
        </p>
        <button type="button" onClick={() => setPauseDialogOpen(true)}>
          {settings.automationPaused ? "Resume automation…" : "Pause automation…"}
        </button>
      </section>

      <section aria-labelledby="data-location-heading">
        <h2 id="data-location-heading">Local data</h2>
        <dl className="fact-list">
          <div>
            <dt>Data directory</dt>
            <dd>
              <code>{settings.dataDirectory}</code>
            </dd>
          </div>
          <div>
            <dt>Settings last updated</dt>
            <dd>{settings.updatedAt}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="danger-heading" className="danger-zone">
        <h2 id="danger-heading">Destructive data controls</h2>
        <p id={dangerNoteId}>
          Deleting or exporting local data requires a confirmation flow that has
          not shipped yet. These controls stay disabled until it does.
        </p>
        <div className="card-actions">
          <button type="button" disabled aria-describedby={dangerNoteId}>
            Delete all local data
          </button>
          <button type="button" disabled aria-describedby={dangerNoteId}>
            Export and reset database
          </button>
        </div>
      </section>

      {pauseDialogOpen ? (
        <ReasonDialog
          title={settings.automationPaused ? "Resume automation" : "Pause automation"}
          description={
            settings.automationPaused
              ? "Record why automation is being resumed. The reason is written to the audit log."
              : "Record why automation is being paused. The reason is written to the audit log."
          }
          submitLabel={settings.automationPaused ? "Resume" : "Pause"}
          onSubmit={togglePause}
          onCancel={() => setPauseDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
