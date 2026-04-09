import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, TERMINAL_STATUSES } from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";
import { banner, padCol } from "../lib/format.js";

export function registerDispatch(program: Command): void {
  const dispatch = program
    .command("dispatch")
    .description("Auto-dispatch scheduler — automatic work discovery & spawning");

  dispatch
    .command("status")
    .description("Show auto-dispatch status for all projects")
    .action(async () => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      console.log(banner("Auto-Dispatch Status"));

      const header = [
        padCol("Project", 20),
        padCol("Status", 12),
        padCol("Active", 10),
        padCol("Max", 6),
        padCol("Daily Limit", 12),
        padCol("Poll", 8),
        padCol("Mode", 10),
      ].join("");
      console.log(chalk.dim(header));
      console.log(chalk.dim("─".repeat(78)));

      let hasAny = false;

      for (const [projectId, projectConfig] of Object.entries(config.projects)) {
        const ad = projectConfig.autoDispatch;
        const enabled = ad?.enabled ?? false;

        // Count active sessions for this project
        const sessions = await sm.list(projectId);
        const activeSessions = sessions.filter((s) => !TERMINAL_STATUSES.has(s.status));

        const status = enabled ? chalk.green("enabled") : chalk.dim("disabled");
        const maxConcurrent = ad?.maxConcurrent ?? 3;
        const maxDaily = ad?.maxDaily ?? 20;
        const pollMin = ad?.pollInterval ?? 5;
        const mode = ad?.onNewIssue ?? "spawn";

        const row = [
          padCol(projectId, 20),
          padCol(enabled ? "enabled" : "disabled", 12),
          padCol(`${activeSessions.length}/${maxConcurrent}`, 10),
          padCol(String(maxConcurrent), 6),
          padCol(String(maxDaily), 12),
          padCol(`${pollMin}m`, 8),
          padCol(mode, 10),
        ].join("");

        console.log(enabled ? row : chalk.dim(row));
        hasAny = true;
      }

      if (!hasAny) {
        console.log(chalk.dim("  No projects configured"));
      }

      console.log();
      console.log(
        chalk.dim(
          "Configure auto-dispatch in agent-orchestrator.yaml under each project's autoDispatch section.",
        ),
      );
    });
}
