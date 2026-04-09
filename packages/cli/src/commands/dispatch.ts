import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, TERMINAL_STATUSES } from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";
import { banner, padCol } from "../lib/format.js";
import { DEFAULT_PORT } from "../lib/constants.js";

/** Call the dashboard API. Returns parsed JSON or throws. */
async function dashboardApi(
  port: number,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `http://localhost:${port}/api/dispatch/${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((json.error as string) ?? `API returned ${res.status}`);
  }
  return json;
}

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

  dispatch
    .command("queue")
    .description("Show queued issues awaiting approval")
    .option("-p, --port <port>", "Dashboard port", String(DEFAULT_PORT))
    .action(async (opts: { port: string }) => {
      const port = Number(opts.port);

      try {
        const json = await dashboardApi(port, "queue");
        const queue = json.queue as Array<{
          projectId: string;
          issues: Array<{ id: string; title: string; priority?: number }>;
        }>;

        if (!queue || queue.length === 0) {
          console.log(chalk.dim("No issues in the dispatch queue."));
          return;
        }

        console.log(banner("Dispatch Queue"));

        const header = [
          padCol("Project", 20),
          padCol("Issue", 16),
          padCol("Priority", 10),
          padCol("Title", 40),
        ].join("");
        console.log(chalk.dim(header));
        console.log(chalk.dim("─".repeat(86)));

        for (const entry of queue) {
          for (const issue of entry.issues) {
            const row = [
              padCol(entry.projectId, 20),
              padCol(issue.id, 16),
              padCol(issue.priority !== undefined ? String(issue.priority) : "—", 10),
              padCol(issue.title.slice(0, 38), 40),
            ].join("");
            console.log(row);
          }
        }

        console.log();
        console.log(chalk.dim("Use: ao dispatch approve <issue-id>"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ECONNREFUSED")) {
          console.error(chalk.red("Dashboard is not running. Start it with: ao start"));
        } else {
          console.error(chalk.red(`Error: ${msg}`));
        }
        process.exitCode = 1;
      }
    });

  dispatch
    .command("approve <issueId>")
    .description("Approve a queued issue for spawning")
    .option("-p, --port <port>", "Dashboard port", String(DEFAULT_PORT))
    .option("--project <projectId>", "Project ID (optional, searches all if omitted)")
    .action(async (issueId: string, opts: { port: string; project?: string }) => {
      const port = Number(opts.port);

      try {
        const body: Record<string, string> = { issueId };
        if (opts.project) body.projectId = opts.project;

        const json = await dashboardApi(port, "approve", "POST", body);
        if (json.approved) {
          console.log(chalk.green(`✓ Approved ${issueId} — session spawning`));
        } else {
          console.log(chalk.yellow(`Issue ${issueId} was found but spawn failed.`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ECONNREFUSED")) {
          console.error(chalk.red("Dashboard is not running. Start it with: ao start"));
        } else {
          console.error(chalk.red(`Error: ${msg}`));
        }
        process.exitCode = 1;
      }
    });

  dispatch
    .command("reject <issueId>")
    .description("Reject a queued issue (remove from queue)")
    .option("-p, --port <port>", "Dashboard port", String(DEFAULT_PORT))
    .option("--project <projectId>", "Project ID (optional, searches all if omitted)")
    .action(async (issueId: string, opts: { port: string; project?: string }) => {
      const port = Number(opts.port);

      try {
        const body: Record<string, string> = { issueId };
        if (opts.project) body.projectId = opts.project;

        const json = await dashboardApi(port, "reject", "POST", body);
        if (json.rejected) {
          console.log(chalk.green(`✓ Rejected ${issueId} — removed from queue`));
        } else {
          console.log(chalk.yellow(`Issue ${issueId} was found but removal failed.`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ECONNREFUSED")) {
          console.error(chalk.red("Dashboard is not running. Start it with: ao start"));
        } else {
          console.error(chalk.red(`Error: ${msg}`));
        }
        process.exitCode = 1;
      }
    });
}
