import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

/** GET /api/dispatch/queue — List all queued issues across projects */
export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  try {
    const { lifecycleManager } = await getServices();
    const dispatchers = lifecycleManager.getDispatchers();

    const result: Array<{
      projectId: string;
      issues: Array<{ id: string; title: string; priority?: number; url: string }>;
    }> = [];

    for (const [projectId, dispatcher] of dispatchers) {
      const queue = dispatcher.getQueue();
      if (queue.length > 0) {
        result.push({
          projectId,
          issues: queue.map((issue) => ({
            id: issue.id,
            title: issue.title,
            priority: issue.priority,
            url: issue.url,
          })),
        });
      }
    }

    return jsonWithCorrelation({ ok: true, queue: result }, { status: 200 }, correlationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to get dispatch queue";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
