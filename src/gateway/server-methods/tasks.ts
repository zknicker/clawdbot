import {
  defaultTaskOperationsRuntime,
  reloadTaskRegistryFromStore,
} from "openclaw/plugin-sdk/tasks";
import { loadConfig } from "../../config/config.js";
import {
  getRegisteredOperationsRuntime,
  summarizeOperationAuditFindings,
} from "../../plugins/operations-state.js";
import type {
  PluginOperationRecord,
  PluginOperationsRuntime,
} from "../../plugins/operations-state.js";
import {
  ErrorCodes,
  errorShape,
  validateTasksAuditParams,
  validateTasksCancelParams,
  validateTasksListParams,
  validateTasksMaintenanceParams,
  validateTasksNotifyParams,
  validateTasksShowParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function getOperationsRuntime(): PluginOperationsRuntime {
  return getRegisteredOperationsRuntime() ?? defaultTaskOperationsRuntime;
}

function refreshTaskState(): void {
  reloadTaskRegistryFromStore();
}

async function resolveTaskLookupToken(
  operations: PluginOperationsRuntime,
  lookup: string,
): Promise<PluginOperationRecord | null> {
  const token = lookup.trim();
  if (!token) {
    return null;
  }
  const byId = await operations.getById(token);
  if (byId?.namespace === "tasks") {
    return byId;
  }
  const byRunId = await operations.findByRunId(token);
  if (byRunId?.namespace === "tasks") {
    return byRunId;
  }
  const bySession = await operations.list({
    namespace: "tasks",
    sessionKey: token,
    limit: 1,
  });
  return bySession[0] ?? null;
}

function respondLookupError(respond: RespondFn, kind: "Task" | "Flow", lookup: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `${kind} not found: ${lookup}`));
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }
    refreshTaskState();
    const p = params;
    const tasks = await getOperationsRuntime().list({
      namespace: "tasks",
      ...(p.runtime ? { kind: p.runtime.trim() } : {}),
      ...(p.status ? { status: p.status.trim() } : {}),
    });
    respond(
      true,
      {
        count: tasks.length,
        runtime: p.runtime ?? null,
        status: p.status ?? null,
        tasks,
      },
      undefined,
    );
  },
  "tasks.show": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksShowParams, "tasks.show", respond)) {
      return;
    }
    refreshTaskState();
    const task = await resolveTaskLookupToken(getOperationsRuntime(), params.lookup);
    if (!task) {
      respondLookupError(respond, "Task", params.lookup);
      return;
    }
    respond(true, task, undefined);
  },
  "tasks.notify": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksNotifyParams, "tasks.notify", respond)) {
      return;
    }
    refreshTaskState();
    const operations = getOperationsRuntime();
    const task = await resolveTaskLookupToken(operations, params.lookup);
    if (!task) {
      respondLookupError(respond, "Task", params.lookup);
      return;
    }
    const updated = await operations.dispatch({
      type: "patch",
      operationId: task.operationId,
      at: Date.now(),
      metadataPatch: {
        notifyPolicy: params.notify,
      },
    });
    if (!updated.matched || !updated.record) {
      respondLookupError(respond, "Task", params.lookup);
      return;
    }
    respond(
      true,
      {
        task: updated.record,
      },
      undefined,
    );
  },
  "tasks.cancel": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksCancelParams, "tasks.cancel", respond)) {
      return;
    }
    refreshTaskState();
    const operations = getOperationsRuntime();
    const task = await resolveTaskLookupToken(operations, params.lookup);
    if (!task) {
      respondLookupError(respond, "Task", params.lookup);
      return;
    }
    const result = await operations.cancel({
      cfg: loadConfig(),
      operationId: task.operationId,
    });
    if (!result.found) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, result.reason ?? `Task not found: ${params.lookup}`),
      );
      return;
    }
    if (!result.cancelled) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          result.reason ?? `Could not cancel task: ${params.lookup}`,
        ),
      );
      return;
    }
    const updated = await operations.getById(task.operationId);
    respond(
      true,
      {
        result,
        task: updated ?? task,
      },
      undefined,
    );
  },
  "tasks.audit": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksAuditParams, "tasks.audit", respond)) {
      return;
    }
    refreshTaskState();
    const operations = getOperationsRuntime();
    const allFindings = await operations.audit({
      namespace: "tasks",
    });
    const findings = await operations.audit({
      namespace: "tasks",
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.code ? { code: params.code.trim() } : {}),
    });
    const displayed =
      typeof params.limit === "number" && params.limit > 0
        ? findings.slice(0, params.limit)
        : findings;
    respond(
      true,
      {
        count: allFindings.length,
        filteredCount: findings.length,
        displayed: displayed.length,
        filters: {
          severity: params.severity ?? null,
          code: params.code ?? null,
          limit: params.limit ?? null,
        },
        summary: summarizeOperationAuditFindings(allFindings),
        findings: displayed,
      },
      undefined,
    );
  },
  "tasks.maintenance": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksMaintenanceParams, "tasks.maintenance", respond)) {
      return;
    }
    refreshTaskState();
    const operations = getOperationsRuntime();
    const auditBeforeFindings = await operations.audit({
      namespace: "tasks",
    });
    const maintenance = await operations.maintenance({
      namespace: "tasks",
      apply: Boolean(params.apply),
    });
    const tasks = await operations.summarize({
      namespace: "tasks",
    });
    const auditAfterFindings = params.apply
      ? await operations.audit({
          namespace: "tasks",
        })
      : auditBeforeFindings;
    respond(
      true,
      {
        mode: params.apply ? "apply" : "preview",
        maintenance,
        tasks,
        auditBefore: summarizeOperationAuditFindings(auditBeforeFindings),
        auditAfter: summarizeOperationAuditFindings(auditAfterFindings),
      },
      undefined,
    );
  },
};
