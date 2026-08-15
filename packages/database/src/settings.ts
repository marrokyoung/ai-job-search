import { randomUUID } from "node:crypto";
import type { AutomationMode, EventActor } from "@us-job-agent/domain";
import type Database from "better-sqlite3";
import { getDatabaseConnection } from "./database-internal.ts";
import type { JobAgentDatabase } from "./database.ts";

export type AutomationSettingsView = {
  automationPaused: boolean;
  defaultMode: AutomationMode;
  dailyApplicationLimit: number;
  updatedAt: string;
};

export type UpdateAutomationSettingsInput = {
  defaultMode?: AutomationMode;
  dailyApplicationLimit?: number;
  now?: string;
};

type SettingsRow = {
  globally_paused: 0 | 1;
  default_mode: AutomationMode;
  daily_application_limit: number;
  updated_at: string;
};

export class SettingsRepository {
  constructor(private readonly database: JobAgentDatabase) {}

  private get sqlite(): Database.Database {
    return getDatabaseConnection(this.database);
  }

  private read(): SettingsRow {
    return this.sqlite
      .prepare(
        `SELECT globally_paused, default_mode, daily_application_limit, updated_at
         FROM automation_settings WHERE singleton_id = 1`,
      )
      .get() as SettingsRow;
  }

  private toView(row: SettingsRow): AutomationSettingsView {
    return {
      automationPaused: Boolean(row.globally_paused),
      defaultMode: row.default_mode,
      dailyApplicationLimit: row.daily_application_limit,
      updatedAt: row.updated_at,
    };
  }

  get(): AutomationSettingsView {
    return this.toView(this.read());
  }

  update(input: UpdateAutomationSettingsInput): AutomationSettingsView {
    if (input.defaultMode === undefined && input.dailyApplicationLimit === undefined) {
      throw new Error("A settings update must change at least one field.");
    }
    if (
      input.dailyApplicationLimit !== undefined &&
      (!Number.isInteger(input.dailyApplicationLimit) || input.dailyApplicationLimit < 0)
    ) {
      throw new Error("The daily application limit must be a non-negative integer.");
    }
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const current = this.read();
      this.sqlite
        .prepare(
          `UPDATE automation_settings
           SET default_mode = ?, daily_application_limit = ?, updated_at = ?
           WHERE singleton_id = 1`,
        )
        .run(
          input.defaultMode ?? current.default_mode,
          input.dailyApplicationLimit ?? current.daily_application_limit,
          now,
        );
      return this.toView(this.read());
    })();
  }

  setPaused(input: {
    paused: boolean;
    reason?: string;
    actor?: EventActor;
    now?: string;
  }): AutomationSettingsView {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE automation_settings
           SET globally_paused = ?, updated_at = ?
           WHERE singleton_id = 1`,
        )
        .run(input.paused ? 1 : 0, now);
      this.sqlite
        .prepare(
          `INSERT INTO audit_events (id, event_name, actor, occurred_at, details_json)
           VALUES (?, 'automation_pause_changed', ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.actor ?? "user",
          now,
          JSON.stringify({ paused: input.paused, reason: input.reason ?? null }),
        );
      return this.get();
    })();
  }
}
