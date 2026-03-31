import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const TaskNotifyPolicySchema = Type.Union([
  Type.Literal("done_only"),
  Type.Literal("state_changes"),
  Type.Literal("silent"),
]);

export const TasksListParamsSchema = Type.Object(
  {
    runtime: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksShowParamsSchema = Type.Object(
  {
    lookup: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TasksNotifyParamsSchema = Type.Object(
  {
    lookup: NonEmptyString,
    notify: TaskNotifyPolicySchema,
  },
  { additionalProperties: false },
);

export const TasksCancelParamsSchema = Type.Object(
  {
    lookup: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TasksAuditParamsSchema = Type.Object(
  {
    severity: Type.Optional(Type.Union([Type.Literal("warn"), Type.Literal("error")])),
    code: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const TasksMaintenanceParamsSchema = Type.Object(
  {
    apply: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

