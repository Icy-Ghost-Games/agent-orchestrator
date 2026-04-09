"use client";

import { useCallback, useEffect, useState } from "react";

interface QueuedIssue {
  id: string;
  title: string;
  priority?: number;
  url: string;
}

interface QueueEntry {
  projectId: string;
  issues: QueuedIssue[];
}

const PRIORITY_LABELS: Record<number, string> = {
  1: "Critical",
  2: "High",
  3: "Medium",
  4: "Low",
  5: "Lowest",
};

export function DispatchQueue() {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [acting, setActing] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/dispatch/queue");
      if (!res.ok) return;
      const json = (await res.json()) as { queue?: QueueEntry[] };
      setQueue(json.queue ?? []);
    } catch {
      // Dashboard may not have dispatchers running — silently ignore
    }
  }, []);

  useEffect(() => {
    void fetchQueue();
    const interval = setInterval(() => void fetchQueue(), 10_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const handleAction = useCallback(
    async (action: "approve" | "reject", issueId: string, projectId: string) => {
      setActing(issueId);
      try {
        const res = await fetch(`/api/dispatch/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId, projectId }),
        });
        if (res.ok) {
          // Optimistically remove from local queue
          setQueue((prev) =>
            prev
              .map((entry) => ({
                ...entry,
                issues: entry.issues.filter((i) => i.id !== issueId),
              }))
              .filter((entry) => entry.issues.length > 0),
          );
        }
      } catch {
        // Ignore — next poll will refresh
      } finally {
        setActing(null);
      }
    },
    [],
  );

  const totalIssues = queue.reduce((sum, entry) => sum + entry.issues.length, 0);
  if (totalIssues === 0) return null;

  return (
    <div className="dispatch-queue">
      <div className="dispatch-queue__header">
        <span className="dispatch-queue__badge">{totalIssues}</span>
        <span className="dispatch-queue__title">Queued for dispatch</span>
        <span className="dispatch-queue__subtitle">
          Issues awaiting approval before agent sessions are spawned
        </span>
      </div>
      <div className="dispatch-queue__list">
        {queue.map((entry) =>
          entry.issues.map((issue) => (
            <div key={`${entry.projectId}:${issue.id}`} className="dispatch-queue__item">
              <div className="dispatch-queue__item-info">
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dispatch-queue__issue-id"
                >
                  {issue.id}
                </a>
                <span className="dispatch-queue__issue-title">{issue.title}</span>
                {issue.priority !== undefined && (
                  <span className="dispatch-queue__priority">
                    {PRIORITY_LABELS[issue.priority] ?? `P${issue.priority}`}
                  </span>
                )}
                <span className="dispatch-queue__project">{entry.projectId}</span>
              </div>
              <div className="dispatch-queue__actions">
                <button
                  onClick={() => void handleAction("approve", issue.id, entry.projectId)}
                  disabled={acting === issue.id}
                  className="dispatch-queue__btn dispatch-queue__btn--approve"
                >
                  {acting === issue.id ? "..." : "Approve"}
                </button>
                <button
                  onClick={() => void handleAction("reject", issue.id, entry.projectId)}
                  disabled={acting === issue.id}
                  className="dispatch-queue__btn dispatch-queue__btn--reject"
                >
                  Skip
                </button>
              </div>
            </div>
          )),
        )}
      </div>
    </div>
  );
}
