import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

/** POST /api/dispatch/reject — Reject a queued issue (remove from queue) */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const issueId = typeof body?.issueId === "string" ? body.issueId : "";
  const idErr = validateIdentifier(issueId, "issueId");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  const projectId = typeof body?.projectId === "string" ? body.projectId : undefined;

  try {
    const { lifecycleManager } = await getServices();
    const dispatchers = lifecycleManager.getDispatchers();

    const targets = projectId
      ? dispatchers.has(projectId)
        ? [[projectId, dispatchers.get(projectId)!] as const]
        : []
      : [...dispatchers];

    for (const [projId, dispatcher] of targets) {
      const found = dispatcher.getQueue().some((issue) => issue.id === issueId);
      if (found) {
        const success = dispatcher.reject(issueId);
        return jsonWithCorrelation(
          { ok: true, rejected: success, projectId: projId, issueId },
          { status: 200 },
          correlationId,
        );
      }
    }

    return jsonWithCorrelation(
      { error: `Issue ${issueId} not found in any dispatch queue` },
      { status: 404 },
      correlationId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to reject issue";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
