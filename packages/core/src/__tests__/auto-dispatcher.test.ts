import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutoDispatcher } from "../auto-dispatcher.js";
import type { AutoDispatcherDeps } from "../auto-dispatcher.js";
import type {
  AutoDispatchConfig,
  Issue,
  Tracker,
  SessionManager,
  Notifier,
  ProjectConfig,
  Session,
  SessionStatus,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "ISSUE-1",
    title: "Test issue",
    description: "desc",
    url: "https://example.com/ISSUE-1",
    state: "open",
    labels: [],
    priority: 3,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working" as SessionStatus,
    activity: null,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AutoDispatchConfig> = {}): AutoDispatchConfig {
  return {
    enabled: true,
    pollInterval: 5,
    maxConcurrent: 3,
    maxDaily: 20,
    requireApproval: false,
    onNewIssue: "spawn",
    ...overrides,
  };
}

function makeProject(): ProjectConfig {
  return {
    name: "my-app",
    repo: "org/my-app",
    path: "/tmp/my-app",
    defaultBranch: "main",
    sessionPrefix: "app",
  };
}

function makeDeps(overrides: Partial<AutoDispatcherDeps> = {}): AutoDispatcherDeps {
  return {
    config: makeConfig(),
    orchestratorConfig: { configPath: "/tmp/ao.yaml", projects: {}, notifiers: {}, notificationRouting: {}, reactions: {}, defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] }, readyThresholdMs: 300_000 } as never,
    projectId: "my-app",
    project: makeProject(),
    tracker: {
      name: "mock",
      getIssue: vi.fn(),
      isCompleted: vi.fn(),
      issueUrl: vi.fn(),
      branchName: vi.fn(),
      generatePrompt: vi.fn(),
      listIssues: vi.fn().mockResolvedValue([]),
    } as unknown as Tracker,
    sessionManager: {
      spawn: vi.fn().mockResolvedValue(makeSession()),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      kill: vi.fn(),
      restore: vi.fn(),
      cleanup: vi.fn(),
      send: vi.fn(),
      claimPR: vi.fn(),
      spawnOrchestrator: vi.fn(),
    } as unknown as SessionManager,
    notifiers: [],
    observer: {
      recordOperation: vi.fn(),
      setHealth: vi.fn(),
    } as unknown as ProjectObserver,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoDispatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns eligible issues up to available slots", async () => {
    const issues = [
      makeIssue({ id: "A", priority: 2 }),
      makeIssue({ id: "B", priority: 3 }),
      makeIssue({ id: "C", priority: 4 }),
    ];
    const deps = makeDeps({
      config: makeConfig({ maxConcurrent: 2 }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue(issues);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith({ projectId: "my-app", issueId: "A" });
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith({ projectId: "my-app", issueId: "B" });
  });

  it("skips when daily limit is reached", async () => {
    const deps = makeDeps({
      config: makeConfig({ maxDaily: 1 }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([
      makeIssue({ id: "A" }),
      makeIssue({ id: "B" }),
    ]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);

    // First tick — spawns 1 (maxDaily=1)
    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(1);

    // Second tick — daily limit hit
    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it("skips when all concurrency slots are filled", async () => {
    const deps = makeDeps({
      config: makeConfig({ maxConcurrent: 1 }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([makeIssue({ id: "A" })]);
    // One active session already running
    vi.mocked(deps.sessionManager.list).mockResolvedValue([
      makeSession({ id: "app-1", status: "working" as SessionStatus }),
    ]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("does not re-spawn already-claimed issues", async () => {
    const deps = makeDeps();
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([
      makeIssue({ id: "A" }),
    ]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);

    // First tick claims A
    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(1);

    // Second tick — A is claimed, skip
    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it("unclaim frees the issue for re-dispatch", async () => {
    const deps = makeDeps();
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([
      makeIssue({ id: "A" }),
    ]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);

    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(1);

    d.unclaim("A");

    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(2);
  });

  it("filters issues by excludeLabels", async () => {
    const deps = makeDeps({
      config: makeConfig({
        filters: {
          excludeLabels: ["blocked", "wont-fix"],
        },
      }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([
      makeIssue({ id: "A", labels: ["blocked"] }),
      makeIssue({ id: "B", labels: ["feature"] }),
      makeIssue({ id: "C", labels: ["wont-fix", "feature"] }),
    ]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith({ projectId: "my-app", issueId: "B" });
  });

  it("filters issues by minPriority", async () => {
    const deps = makeDeps({
      config: makeConfig({
        filters: {
          minPriority: "Medium",
          excludeLabels: [],
        },
      }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([
      makeIssue({ id: "A", priority: 2 }), // High — passes
      makeIssue({ id: "B", priority: 4 }), // Low — filtered
      makeIssue({ id: "C", priority: 3 }), // Medium — passes
    ]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith({ projectId: "my-app", issueId: "A" });
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith({ projectId: "my-app", issueId: "C" });
  });

  it("sorts by priority (higher priority first)", async () => {
    const deps = makeDeps({
      config: makeConfig({ maxConcurrent: 2 }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([
      makeIssue({ id: "LOW", priority: 4 }),
      makeIssue({ id: "HIGH", priority: 1 }),
      makeIssue({ id: "MED", priority: 3 }),
    ]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    const calls = vi.mocked(deps.sessionManager.spawn).mock.calls;
    expect(calls[0][0]).toEqual({ projectId: "my-app", issueId: "HIGH" });
    expect(calls[1][0]).toEqual({ projectId: "my-app", issueId: "MED" });
  });

  it("queues issues when onNewIssue is 'queue'", async () => {
    const deps = makeDeps({
      config: makeConfig({ onNewIssue: "queue" }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([makeIssue({ id: "A" })]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
    expect(d.getQueue()).toHaveLength(1);
    expect(d.getQueue()[0].id).toBe("A");
  });

  it("queues issues when requireApproval is true", async () => {
    const deps = makeDeps({
      config: makeConfig({ requireApproval: true }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([makeIssue({ id: "A" })]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
    expect(d.getQueue()).toHaveLength(1);
  });

  it("approve spawns from queue and claims the issue", async () => {
    const deps = makeDeps({
      config: makeConfig({ onNewIssue: "queue" }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([makeIssue({ id: "A" })]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(d.getQueue()).toHaveLength(1);

    const result = await d.approve("A");
    expect(result).toBe(true);
    expect(deps.sessionManager.spawn).toHaveBeenCalledWith({ projectId: "my-app", issueId: "A" });
    expect(d.getQueue()).toHaveLength(0);
    expect(d.getClaimedIssues().has("A")).toBe(true);
  });

  it("reject removes issue from queue", async () => {
    const deps = makeDeps({
      config: makeConfig({ onNewIssue: "queue" }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([makeIssue({ id: "A" })]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    const result = d.reject("A");
    expect(result).toBe(true);
    expect(d.getQueue()).toHaveLength(0);
    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("notifies when onNewIssue is 'notify'", async () => {
    const mockNotifier = {
      name: "mock",
      notify: vi.fn().mockResolvedValue(undefined),
    } as unknown as Notifier;

    const deps = makeDeps({
      config: makeConfig({ onNewIssue: "notify" }),
      notifiers: [mockNotifier],
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([makeIssue({ id: "A" })]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
    expect(mockNotifier.notify).toHaveBeenCalled();
  });

  it("handles tracker API failure gracefully", async () => {
    const deps = makeDeps();
    vi.mocked(deps.tracker.listIssues!).mockRejectedValue(new Error("API down"));
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);

    // Should not throw
    await d.tick();

    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
    expect(deps.observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "autodispatch.fetch_issues",
        outcome: "failure",
      }),
    );
  });

  it("handles spawn failure gracefully", async () => {
    const deps = makeDeps();
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([makeIssue({ id: "A" })]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);
    vi.mocked(deps.sessionManager.spawn).mockRejectedValue(new Error("Spawn failed"));

    const d = createAutoDispatcher(deps);

    // Should not throw
    await d.tick();

    expect(deps.observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "autodispatch.spawn",
        outcome: "failure",
      }),
    );
  });

  it("resets daily count at midnight", async () => {
    const deps = makeDeps({
      config: makeConfig({ maxDaily: 1 }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([
      makeIssue({ id: "A" }),
      makeIssue({ id: "B" }),
    ]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);

    // Day 1: spawn 1
    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(d.getDailySpawnCount()).toBe(1);

    // Advance to next day
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    // Day 2: daily count should reset
    d.unclaim("A"); // free up for re-dispatch
    await d.tick();
    expect(deps.sessionManager.spawn).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch when tracker has no listIssues", async () => {
    const deps = makeDeps();
    // Remove listIssues
    (deps.tracker as unknown as Record<string, unknown>).listIssues = undefined;
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    await d.tick();

    expect(deps.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it("start and stop control the polling interval", async () => {
    const deps = makeDeps({
      config: makeConfig({ pollInterval: 1 }),
    });
    vi.mocked(deps.tracker.listIssues!).mockResolvedValue([]);
    vi.mocked(deps.sessionManager.list).mockResolvedValue([]);

    const d = createAutoDispatcher(deps);
    d.start();

    // Should have called tick once immediately (via start → void tick())
    // Advance 1 minute
    await vi.advanceTimersByTimeAsync(60_000);

    d.stop();

    const callsBefore = vi.mocked(deps.tracker.listIssues!).mock.calls.length;

    // Advance another minute — should not trigger more ticks
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.mocked(deps.tracker.listIssues!).mock.calls.length).toBe(callsBefore);
  });
});
