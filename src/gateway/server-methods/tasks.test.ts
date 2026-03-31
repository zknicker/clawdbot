import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn(() => ({ runtime: "test" }));
const getRegisteredOperationsRuntimeMock = vi.fn();
const reloadTaskRegistryFromStoreMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../../plugins/operations-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/operations-state.js")>();
  return {
    ...actual,
    getRegisteredOperationsRuntime: () => getRegisteredOperationsRuntimeMock(),
  };
});

vi.mock("openclaw/plugin-sdk/tasks", () => ({
  defaultTaskOperationsRuntime: {
    getById: vi.fn(),
    findByRunId: vi.fn(),
    list: vi.fn(),
    summarize: vi.fn(),
    audit: vi.fn(),
    maintenance: vi.fn(),
    dispatch: vi.fn(),
    cancel: vi.fn(),
  },
  reloadTaskRegistryFromStore: (...args: unknown[]) => reloadTaskRegistryFromStoreMock(...args),
}));

function createOperationsRuntime() {
  return {
    getById: vi.fn(),
    findByRunId: vi.fn(),
    list: vi.fn(),
    summarize: vi.fn(),
    audit: vi.fn(),
    maintenance: vi.fn(),
    dispatch: vi.fn(),
    cancel: vi.fn(),
  };
}

beforeEach(() => {
  getRegisteredOperationsRuntimeMock.mockReset();
  reloadTaskRegistryFromStoreMock.mockReset();
  loadConfigMock.mockClear();
});

describe("tasksHandlers", () => {
  it("lists task operations under the tasks namespace", async () => {
    const operations = createOperationsRuntime();
    operations.list.mockResolvedValue([
      {
        operationId: "task-1",
        namespace: "tasks",
        kind: "subagent",
        status: "running",
        description: "Do thing",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    getRegisteredOperationsRuntimeMock.mockReturnValue(operations);
    const respond = vi.fn();

    const { tasksHandlers } = await import("./tasks.js");
    await tasksHandlers["tasks.list"]({
      params: { runtime: "subagent", status: "running" },
      respond,
    } as never);

    expect(operations.list).toHaveBeenCalledWith({
      namespace: "tasks",
      kind: "subagent",
      status: "running",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        count: 1,
        runtime: "subagent",
        status: "running",
      }),
      undefined,
    );
  });

  it("shows a task by run id lookup", async () => {
    const operations = createOperationsRuntime();
    operations.getById.mockResolvedValue(null);
    operations.findByRunId.mockResolvedValue({
      operationId: "task-1",
      namespace: "tasks",
      kind: "subagent",
      status: "running",
      runId: "run-1",
      description: "Do thing",
      createdAt: 1,
      updatedAt: 2,
    });
    getRegisteredOperationsRuntimeMock.mockReturnValue(operations);
    const respond = vi.fn();

    const { tasksHandlers } = await import("./tasks.js");
    await tasksHandlers["tasks.show"]({
      params: { lookup: "run-1" },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        operationId: "task-1",
        runId: "run-1",
      }),
      undefined,
    );
  });

  it("updates notify policy", async () => {
    const operations = createOperationsRuntime();
    operations.getById.mockResolvedValue({
      operationId: "task-1",
      namespace: "tasks",
      kind: "subagent",
      status: "running",
      description: "Do thing",
      createdAt: 1,
      updatedAt: 2,
    });
    operations.dispatch.mockResolvedValue({
      matched: true,
      record: {
        operationId: "task-1",
        namespace: "tasks",
        kind: "subagent",
        status: "running",
        description: "Do thing",
        createdAt: 1,
        updatedAt: 3,
        metadata: {
          notifyPolicy: "silent",
        },
      },
    });
    getRegisteredOperationsRuntimeMock.mockReturnValue(operations);
    const respond = vi.fn();

    const { tasksHandlers } = await import("./tasks.js");
    await tasksHandlers["tasks.notify"]({
      params: { lookup: "task-1", notify: "silent" },
      respond,
    } as never);

    expect(operations.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch",
        operationId: "task-1",
        metadataPatch: {
          notifyPolicy: "silent",
        },
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        task: expect.objectContaining({
          operationId: "task-1",
        }),
      },
      undefined,
    );
  });

  it("cancels a task and returns the refreshed record", async () => {
    const operations = createOperationsRuntime();
    operations.getById
      .mockResolvedValueOnce({
        operationId: "task-1",
        namespace: "tasks",
        kind: "subagent",
        status: "running",
        description: "Do thing",
        createdAt: 1,
        updatedAt: 2,
      })
      .mockResolvedValueOnce({
        operationId: "task-1",
        namespace: "tasks",
        kind: "subagent",
        status: "cancelled",
        description: "Do thing",
        createdAt: 1,
        updatedAt: 3,
      });
    operations.cancel.mockResolvedValue({
      found: true,
      cancelled: true,
      record: {
        operationId: "task-1",
      },
    });
    getRegisteredOperationsRuntimeMock.mockReturnValue(operations);
    const respond = vi.fn();

    const { tasksHandlers } = await import("./tasks.js");
    await tasksHandlers["tasks.cancel"]({
      params: { lookup: "task-1" },
      respond,
    } as never);

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(operations.cancel).toHaveBeenCalledWith({
      cfg: { runtime: "test" },
      operationId: "task-1",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        task: expect.objectContaining({
          status: "cancelled",
        }),
      }),
      undefined,
    );
  });

  it("returns task audit summary payload", async () => {
    const operations = createOperationsRuntime();
    operations.audit
      .mockResolvedValueOnce([
        {
          severity: "warn",
          code: "stale-run",
          operation: { operationId: "task-1", namespace: "tasks", kind: "cron", status: "running" },
          detail: "stale",
        },
        {
          severity: "error",
          code: "lost-run",
          operation: { operationId: "task-2", namespace: "tasks", kind: "cron", status: "lost" },
          detail: "lost",
        },
      ])
      .mockResolvedValueOnce([
        {
          severity: "error",
          code: "lost-run",
          operation: { operationId: "task-2", namespace: "tasks", kind: "cron", status: "lost" },
          detail: "lost",
        },
      ]);
    getRegisteredOperationsRuntimeMock.mockReturnValue(operations);
    const respond = vi.fn();

    const { tasksHandlers } = await import("./tasks.js");
    await tasksHandlers["tasks.audit"]({
      params: { severity: "error", limit: 1 },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        count: 2,
        filteredCount: 1,
        displayed: 1,
        summary: expect.objectContaining({
          total: 2,
          errors: 1,
          warnings: 1,
        }),
      }),
      undefined,
    );
  });

  it("returns maintenance preview payload", async () => {
    const operations = createOperationsRuntime();
    operations.audit.mockResolvedValue([
      {
        severity: "warn",
        code: "stale-run",
        operation: { operationId: "task-1", namespace: "tasks", kind: "cron", status: "running" },
        detail: "stale",
      },
    ]);
    operations.maintenance.mockResolvedValue({
      reconciled: 1,
      cleanupStamped: 2,
      pruned: 3,
    });
    operations.summarize.mockResolvedValue({
      total: 4,
      active: 1,
      terminal: 3,
      failures: 0,
      byNamespace: { tasks: 4 },
      byKind: { cron: 4 },
      byStatus: { running: 1, succeeded: 3 },
    });
    getRegisteredOperationsRuntimeMock.mockReturnValue(operations);
    const respond = vi.fn();

    const { tasksHandlers } = await import("./tasks.js");
    await tasksHandlers["tasks.maintenance"]({
      params: {},
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        mode: "preview",
        maintenance: {
          reconciled: 1,
          cleanupStamped: 2,
          pruned: 3,
        },
      }),
      undefined,
    );
  });
});
