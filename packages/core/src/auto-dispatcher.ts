/**
 * AutoDispatcher — Automatic work discovery & session spawning.
 *
 * Polls the tracker for eligible issues and auto-spawns sessions
 * when capacity is available. Opt-in per project via `autoDispatch` config.
 *
 * Fits alongside the existing LifecycleManager polling loop — uses the
 * same SessionManager.spawn() path as `ao spawn` and the same Tracker
 * plugin interface.
 */

import {
  TERMINAL_STATUSES,
  type AutoDispatchConfig,
  type AutoDispatchFilters,
  type Issue,
  type IssueFilters,
  type OrchestratorConfig,
  type Tracker,
  type SessionManager,
  type Notifier,
  type ProjectConfig,
  type Session,
} from "./types.js";
import type { ProjectObserver } from "./observability.js";
import { createCorrelationId } from "./observability.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

/** Priority name → numeric rank (lower = higher priority). */
const PRIORITY_RANK: Record<string, number> = {
  critical: 1,
  highest: 1,
  urgent: 1,
  high: 2,
  medium: 3,
  normal: 3,
  low: 4,
  lowest: 5,
  trivial: 5,
};

function priorityRank(name: string): number {
  return PRIORITY_RANK[name.toLowerCase()] ?? 3;
}

/** Event data emitted by the dispatcher (passed to observer). */
export interface AutoDispatchEvent {
  action: "spawned" | "queued" | "notified" | "skipped" | "error";
  issueId: string;
  issueTitle?: string;
  reason?: string;
}

export interface AutoDispatcherDeps {
  config: AutoDispatchConfig;
  orchestratorConfig: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  tracker: Tracker;
  sessionManager: SessionManager;
  notifiers: Notifier[];
  observer: ProjectObserver;
}

export interface AutoDispatcher {
  start(): void;
  stop(): void;
  /** Run a single dispatch cycle (exposed for testing). */
  tick(): Promise<void>;
  /** Remove an issue from the claimed set (e.g. when session is destroyed). */
  unclaim(issueId: string): void;
  /** Get the set of currently claimed issue IDs. */
  getClaimedIssues(): ReadonlySet<string>;
  /** Get today's spawn count. */
  getDailySpawnCount(): number;
  /** Get queued issues awaiting approval. */
  getQueue(): Issue[];
  /** Approve a queued issue for spawning. */
  approve(issueId: string): Promise<boolean>;
  /** Reject a queued issue (remove from queue). */
  reject(issueId: string): boolean;
}

export function createAutoDispatcher(deps: AutoDispatcherDeps): AutoDispatcher {
  const { config, orchestratorConfig, projectId, project, tracker, sessionManager, notifiers, observer } = deps;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  const claimedIssues = new Set<string>();
  let dailySpawnCount = 0;
  let dailyResetDate = "";
  const queue: Map<string, Issue> = new Map();

  function resetDailyCountIfNewDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dailyResetDate) {
      dailySpawnCount = 0;
      dailyResetDate = today;
    }
  }

  function applyFilters(issues: Issue[], filters?: AutoDispatchFilters): Issue[] {
    if (!filters) return issues;

    return issues.filter((issue) => {
      // minPriority: skip issues with lower priority (higher rank number)
      if (filters.minPriority && issue.priority !== undefined) {
        const threshold = priorityRank(filters.minPriority);
        if (issue.priority > threshold) return false;
      }

      // excludeLabels: skip issues with any excluded label
      if (filters.excludeLabels.length > 0) {
        const excluded = new Set(filters.excludeLabels.map((l) => l.toLowerCase()));
        if (issue.labels.some((l) => excluded.has(l.toLowerCase()))) return false;
      }

      return true;
    });
  }

  async function notifyAll(message: string): Promise<void> {
    for (const notifier of notifiers) {
      try {
        await notifier.notify({
          id: createCorrelationId("autodispatch"),
          type: "session.spawned",
          priority: "info",
          sessionId: "system",
          projectId,
          timestamp: new Date(),
          message,
          data: {},
        });
      } catch {
        // Non-fatal
      }
    }
  }

  async function dispatch(issue: Issue): Promise<void> {
    const correlationId = createCorrelationId("autodispatch");

    if (config.onNewIssue === "notify") {
      await notifyAll(`[auto-dispatch] New eligible issue: ${issue.id} — ${issue.title}`);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "autodispatch.notified",
        outcome: "success",
        correlationId,
        projectId,
        data: { issueId: issue.id, issueTitle: issue.title },
        level: "info",
      });
      return;
    }

    if (config.onNewIssue === "queue" || config.requireApproval) {
      queue.set(issue.id, issue);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "autodispatch.queued",
        outcome: "success",
        correlationId,
        projectId,
        data: { issueId: issue.id, issueTitle: issue.title },
        level: "info",
      });
      return;
    }

    // Spawn
    try {
      const session = await sessionManager.spawn({ projectId, issueId: issue.id });
      claimedIssues.add(issue.id);
      dailySpawnCount++;

      // Mark session as auto-dispatched for dashboard badge
      try {
        const sessionsDir = getSessionsDir(orchestratorConfig.configPath, project.path);
        updateMetadata(sessionsDir, session.id, { autoDispatched: "true" });
      } catch {
        // Non-fatal — session works fine without the label
      }

      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "autodispatch.spawned",
        outcome: "success",
        correlationId,
        projectId,
        data: { issueId: issue.id, issueTitle: issue.title, sessionId: session.id },
        level: "info",
      });
      await notifyAll(`[auto-dispatch] Spawned session for ${issue.id}: ${issue.title}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "autodispatch.spawn",
        outcome: "failure",
        correlationId,
        projectId,
        reason,
        data: { issueId: issue.id },
        level: "error",
      });
    }
  }

  async function syncClaimedIssues(): Promise<void> {
    const sessions = await sessionManager.list(projectId);
    for (const session of sessions) {
      if (session.issueId && !TERMINAL_STATUSES.has(session.status)) {
        claimedIssues.add(session.issueId);
      }
    }
  }

  async function getActiveSessions(): Promise<Session[]> {
    const sessions = await sessionManager.list(projectId);
    return sessions.filter((s) => !TERMINAL_STATUSES.has(s.status));
  }

  async function tick(): Promise<void> {
    const correlationId = createCorrelationId("autodispatch-tick");

    try {
      // Guard: daily limit
      resetDailyCountIfNewDay();
      if (dailySpawnCount >= config.maxDaily) return;

      // Guard: concurrency
      const activeSessions = await getActiveSessions();
      const availableSlots = config.maxConcurrent - activeSessions.length;
      if (availableSlots <= 0) return;

      // Guard: tracker must support listIssues
      if (!tracker.listIssues) return;

      // Fetch eligible issues from tracker
      const filters: IssueFilters = { state: "open" };
      let issues: Issue[];
      try {
        issues = await tracker.listIssues(filters, project);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "autodispatch.fetch_issues",
          outcome: "failure",
          correlationId,
          projectId,
          reason,
          level: "warn",
        });
        return;
      }

      // Filter out already-claimed issues (active sessions)
      const unclaimed = issues.filter((i) => !claimedIssues.has(i.id));

      // Apply additional filters
      const eligible = applyFilters(unclaimed, config.filters);

      // Sort by priority (lower number = higher priority)
      eligible.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

      // Take up to availableSlots issues, respecting daily limit
      const remainingDaily = config.maxDaily - dailySpawnCount;
      const toSpawn = eligible.slice(0, Math.min(availableSlots, remainingDaily));

      for (const issue of toSpawn) {
        await dispatch(issue);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "autodispatch.tick",
        outcome: "failure",
        correlationId,
        projectId,
        reason,
        level: "error",
      });
    }
  }

  return {
    start(): void {
      if (intervalHandle) return;
      // Sync claimed issues from existing sessions on startup
      void syncClaimedIssues();
      // Run first tick immediately, then on interval
      void tick();
      intervalHandle = setInterval(
        () => void tick(),
        config.pollInterval * 60 * 1000,
      );
    },

    stop(): void {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },

    tick,

    unclaim(issueId: string): void {
      claimedIssues.delete(issueId);
    },

    getClaimedIssues(): ReadonlySet<string> {
      return claimedIssues;
    },

    getDailySpawnCount(): number {
      resetDailyCountIfNewDay();
      return dailySpawnCount;
    },

    getQueue(): Issue[] {
      return Array.from(queue.values());
    },

    async approve(issueId: string): Promise<boolean> {
      const issue = queue.get(issueId);
      if (!issue) return false;
      queue.delete(issueId);

      try {
        await sessionManager.spawn({ projectId, issueId: issue.id });
        claimedIssues.add(issue.id);
        dailySpawnCount++;
        return true;
      } catch {
        return false;
      }
    },

    reject(issueId: string): boolean {
      return queue.delete(issueId);
    },
  };
}
