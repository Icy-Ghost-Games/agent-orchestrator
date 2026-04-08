import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
} from "@/lib/observability";
import { getPrimaryProjectId } from "@/lib/project-name";

/** POST /api/sessions/cleanup — Archive all terminal sessions (destroy runtime + worktree) */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();

  try {
    const { config, sessionManager } = await getServices();
    const projectId = getPrimaryProjectId();
    const result = await sessionManager.cleanup(projectId ?? undefined);
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/cleanup",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: projectId ?? undefined,
      data: { killed: result.killed.length, skipped: result.skipped.length },
    });
    return jsonWithCorrelation(
      { ok: true, killed: result.killed, skipped: result.skipped, errors: result.errors },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/cleanup",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        reason: err instanceof Error ? err.message : "Failed to cleanup sessions",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to cleanup sessions";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
