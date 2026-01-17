import fs from "node:fs/promises";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { Api } from "@mariozechner/pi-ai";

import { resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { acquireSessionWriteLock } from "../agents/session-write-lock.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelHeartbeatDeps } from "../channels/plugins/types.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveAgentMainSessionKey,
  resolveStorePath,
  saveSessionStore,
  updateSessionStore,
} from "../config/sessions.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging.js";
import { getQueueSize } from "../process/command-queue.js";
import {
  buildAgentPeerSessionKey,
  normalizeAgentId,
  normalizeMainKey,
} from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { parseTelegramTarget } from "../telegram/targets.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { isWhatsAppGroupJid } from "../whatsapp/normalize.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";
import {
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  requestHeartbeatNow,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveHeartbeatDeliveryTarget } from "./outbound/targets.js";

type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    nowMs?: () => number;
  };

const log = createSubsystemLogger("gateway/heartbeat");
let heartbeatsEnabled = true;
const HEARTBEAT_CONTEXT_LIMIT = 10;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  ackMaxChars: number;
};

const DEFAULT_HEARTBEAT_TARGET = "last";

function hasExplicitHeartbeatAgents(cfg: ClawdbotConfig) {
  const list = cfg.agents?.list ?? [];
  return list.some((entry) => Boolean(entry?.heartbeat));
}

export function isHeartbeatEnabledForAgent(cfg: ClawdbotConfig, agentId?: string): boolean {
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const list = cfg.agents?.list ?? [];
  const hasExplicit = hasExplicitHeartbeatAgents(cfg);
  if (hasExplicit) {
    return list.some(
      (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === resolvedAgentId,
    );
  }
  return resolvedAgentId === resolveDefaultAgentId(cfg);
}

function resolveHeartbeatConfig(
  cfg: ClawdbotConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) return defaults;
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) return overrides;
  return { ...defaults, ...overrides };
}

export function resolveHeartbeatSummaryForAgent(
  cfg: ClawdbotConfig,
  agentId?: string,
): HeartbeatSummary {
  const defaults = cfg.agents?.defaults?.heartbeat;
  const overrides = agentId ? resolveAgentConfig(cfg, agentId)?.heartbeat : undefined;
  const enabled = isHeartbeatEnabledForAgent(cfg, agentId);

  if (!enabled) {
    return {
      enabled: false,
      every: "disabled",
      everyMs: null,
      prompt: resolveHeartbeatPromptText(defaults?.prompt),
      target: defaults?.target ?? DEFAULT_HEARTBEAT_TARGET,
      model: defaults?.model,
      ackMaxChars: Math.max(0, defaults?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS),
    };
  }

  const merged = defaults || overrides ? { ...defaults, ...overrides } : undefined;
  const every = merged?.every ?? defaults?.every ?? overrides?.every ?? DEFAULT_HEARTBEAT_EVERY;
  const everyMs = resolveHeartbeatIntervalMs(cfg, undefined, merged);
  const prompt = resolveHeartbeatPromptText(
    merged?.prompt ?? defaults?.prompt ?? overrides?.prompt,
  );
  const target =
    merged?.target ?? defaults?.target ?? overrides?.target ?? DEFAULT_HEARTBEAT_TARGET;
  const model = merged?.model ?? defaults?.model ?? overrides?.model;
  const ackMaxChars = Math.max(
    0,
    merged?.ackMaxChars ??
      defaults?.ackMaxChars ??
      overrides?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  return {
    enabled: true,
    every,
    everyMs,
    prompt,
    target,
    model,
    ackMaxChars,
  };
}

function resolveHeartbeatAgents(cfg: ClawdbotConfig): HeartbeatAgent[] {
  const list = cfg.agents?.list ?? [];
  if (hasExplicitHeartbeatAgents(cfg)) {
    return list
      .filter((entry) => entry?.heartbeat)
      .map((entry) => {
        const id = normalizeAgentId(entry.id);
        return { agentId: id, heartbeat: resolveHeartbeatConfig(cfg, id) };
      })
      .filter((entry) => entry.agentId);
  }
  const fallbackId = resolveDefaultAgentId(cfg);
  return [{ agentId: fallbackId, heartbeat: resolveHeartbeatConfig(cfg, fallbackId) }];
}

export function resolveHeartbeatIntervalMs(
  cfg: ClawdbotConfig,
  overrideEvery?: string,
  heartbeat?: HeartbeatConfig,
) {
  const raw =
    overrideEvery ??
    heartbeat?.every ??
    cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  let ms: number;
  try {
    ms = parseDurationMs(trimmed, { defaultUnit: "m" });
  } catch {
    return null;
  }
  if (ms <= 0) return null;
  return ms;
}

export function resolveHeartbeatPrompt(cfg: ClawdbotConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptText(heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt);
}

function resolveHeartbeatAckMaxChars(cfg: ClawdbotConfig, heartbeat?: HeartbeatConfig) {
  return Math.max(
    0,
    heartbeat?.ackMaxChars ??
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
}

function resolveHeartbeatSession(cfg: ClawdbotConfig, agentId?: string) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const sessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
  const storePath = resolveStorePath(sessionCfg?.store, { agentId: storeAgentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  return { sessionKey, storePath, store, entry };
}

function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) return undefined;
  if (!Array.isArray(replyResult)) return replyResult;
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) continue;
    if (payload.text || payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0)) {
      return payload;
    }
  }
  return undefined;
}

function resolveHeartbeatReasoningPayloads(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload[] {
  const payloads = Array.isArray(replyResult) ? replyResult : replyResult ? [replyResult] : [];
  return payloads.filter((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    return text.trimStart().startsWith("Reasoning:");
  });
}

function resolveHeartbeatSender(params: {
  allowFrom: Array<string | number>;
  lastTo?: string;
  provider?: string | null;
}) {
  const { allowFrom, lastTo, provider } = params;
  const candidates = [
    lastTo?.trim(),
    provider && lastTo ? `${provider}:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));

  const allowList = allowFrom
    .map((entry) => String(entry))
    .filter((entry) => entry && entry !== "*");
  if (allowFrom.includes("*")) {
    return candidates[0] ?? "heartbeat";
  }
  if (candidates.length > 0 && allowList.length > 0) {
    const matched = candidates.find((candidate) => allowList.includes(candidate));
    if (matched) return matched;
  }
  if (candidates.length > 0 && allowList.length === 0) {
    return candidates[0];
  }
  if (allowList.length > 0) return allowList[0];
  return candidates[0] ?? "heartbeat";
}

function resolveHeartbeatDeliverySessionKey(params: {
  cfg: ClawdbotConfig;
  mainSessionKey: string;
  channel: string;
  to?: string;
}): string | null {
  const { cfg, mainSessionKey, channel } = params;
  if (mainSessionKey === "global") return null;
  const to = params.to?.trim();
  if (!to) return null;

  const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);

  const stripPrefix = (value: string, prefix: string) =>
    value.toLowerCase().startsWith(prefix) ? value.slice(prefix.length).trim() : "";

  const buildKey = (peerKind: "group" | "channel", peerId: string) =>
    buildAgentPeerSessionKey({
      agentId,
      mainKey,
      channel,
      peerKind,
      peerId,
    });

  switch (channel) {
    case "discord": {
      const channelId = stripPrefix(to, "channel:");
      if (channelId) return buildKey("channel", channelId);
      return null;
    }
    case "slack": {
      const groupId = stripPrefix(to, "group:");
      if (groupId) return buildKey("group", groupId);
      const channelId = stripPrefix(to, "channel:");
      if (!channelId) return null;
      const kind =
        channelId.toUpperCase().startsWith("G") || channelId.toUpperCase().startsWith("H")
          ? "group"
          : "channel";
      return buildKey(kind, channelId);
    }
    case "telegram": {
      const target = parseTelegramTarget(to);
      const chatId = target.chatId.trim();
      if (!chatId) return null;
      const isGroup = target.messageThreadId != null || chatId.startsWith("-");
      if (!isGroup) return null;
      const peerId =
        target.messageThreadId != null ? `${chatId}:topic:${target.messageThreadId}` : chatId;
      return buildKey("group", peerId);
    }
    case "whatsapp": {
      if (!isWhatsAppGroupJid(to)) return null;
      return buildKey("group", to);
    }
    case "signal": {
      const groupId = stripPrefix(to, "group:");
      if (!groupId) return null;
      return buildKey("group", groupId);
    }
    default:
      return null;
  }
}

function collectTextContent(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

function truncateLine(text: string, limit = 500): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

async function buildHeartbeatChannelContext(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
  limit?: number;
}): Promise<string | null> {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  if (!entry?.sessionId) return null;

  const sessionFile = resolveSessionFilePath(entry.sessionId, entry, { agentId });
  if (!sessionFile) return null;
  try {
    await fs.stat(sessionFile);
  } catch {
    return null;
  }

  const sessionManager = SessionManager.open(sessionFile);
  const context = sessionManager.buildSessionContext();
  const messages = context.messages;
  if (!messages.length) return null;

  const limit = Math.max(1, params.limit ?? HEARTBEAT_CONTEXT_LIMIT);
  const recent = messages.slice(-limit);
  const lines: string[] = [];
  for (const message of recent) {
    const role = message.role;
    if (role === "toolResult") continue;
    const content =
      "content" in message
        ? (message.content as string | Array<{ type: string; text?: string }>)
        : undefined;
    const text = truncateLine(collectTextContent(content));
    if (!text.trim()) continue;
    const label = role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${text.trim()}`);
  }

  if (lines.length === 0) return null;
  return `Recent channel context (last ${lines.length} messages):\n${lines.join("\n")}`;
}

async function appendHeartbeatToDeliverySession(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
  text: string;
  nowMs?: number;
}): Promise<void> {
  const trimmed = params.text.trim();
  if (!trimmed) return;
  const now = params.nowMs ?? Date.now();

  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  if (!entry?.sessionId) return;

  const sessionFile = resolveSessionFilePath(entry.sessionId, entry, { agentId });
  if (!sessionFile) return;
  try {
    await fs.stat(sessionFile);
  } catch {
    return;
  }

  const sessionLock = await acquireSessionWriteLock({ sessionFile });
  let appended = false;
  try {
    const sessionManager = guardSessionManager(SessionManager.open(sessionFile));
    const entries = sessionManager.getEntries();
    let baseAssistant:
      | {
          api: Api;
          provider: string;
          model: string;
        }
      | undefined;
    for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
      const item = entries[idx];
      if (item.type === "message" && item.message?.role === "assistant") {
        baseAssistant = item.message as typeof baseAssistant;
        break;
      }
    }
    if (!baseAssistant) return;

    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: trimmed }],
      api: baseAssistant.api,
      provider: baseAssistant.provider,
      model: baseAssistant.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: now,
    });
    appended = true;
  } finally {
    await sessionLock.release();
  }

  if (appended) {
    store[params.sessionKey] = { ...entry, updatedAt: now };
    await saveSessionStore(storePath, store);
  }
}

async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") return;
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) return;
  const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
  if (entry.updatedAt === nextUpdatedAt) return;
  await updateSessionStore(storePath, (nextStore) => {
    const nextEntry = nextStore[sessionKey] ?? entry;
    if (!nextEntry) return;
    const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
    if (nextEntry.updatedAt === resolvedUpdatedAt) return;
    nextStore[sessionKey] = { ...nextEntry, updatedAt: resolvedUpdatedAt };
  });
}

function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix: string | undefined,
  ackMaxChars: number,
) {
  const stripped = stripHeartbeatToken(payload.text, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  });
  const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
  if (stripped.shouldSkip && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
    };
  }
  let finalText = stripped.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return { shouldSkip: false, text: finalText, hasMedia };
}

export async function runHeartbeatOnce(opts: {
  cfg?: ClawdbotConfig;
  agentId?: string;
  heartbeat?: HeartbeatConfig;
  reason?: string;
  deps?: HeartbeatDeps;
}): Promise<HeartbeatRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const agentId = normalizeAgentId(opts.agentId ?? resolveDefaultAgentId(cfg));
  const heartbeat = opts.heartbeat ?? resolveHeartbeatConfig(cfg, agentId);
  if (!heartbeatsEnabled) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!isHeartbeatEnabledForAgent(cfg, agentId)) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!resolveHeartbeatIntervalMs(cfg, undefined, heartbeat)) {
    return { status: "skipped", reason: "disabled" };
  }

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)("main");
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  const { entry, sessionKey, storePath } = resolveHeartbeatSession(cfg, agentId);
  const previousUpdatedAt = entry?.updatedAt;
  const delivery = resolveHeartbeatDeliveryTarget({ cfg, entry, heartbeat });
  const deliverySessionKey =
    delivery.channel !== "none"
      ? resolveHeartbeatDeliverySessionKey({
          cfg,
          mainSessionKey: sessionKey,
          channel: delivery.channel,
          to: delivery.to,
        })
      : null;
  const lastChannel =
    delivery.lastChannel && delivery.lastChannel !== INTERNAL_MESSAGE_CHANNEL
      ? normalizeChannelId(delivery.lastChannel)
      : undefined;
  const lastAccountId = delivery.lastAccountId;
  const senderProvider = delivery.channel !== "none" ? delivery.channel : lastChannel;
  const senderAllowFrom = senderProvider
    ? (getChannelPlugin(senderProvider)?.config.resolveAllowFrom?.({
        cfg,
        accountId: senderProvider === lastChannel ? lastAccountId : undefined,
      }) ?? [])
    : [];
  const sender = resolveHeartbeatSender({
    allowFrom: senderAllowFrom,
    lastTo: entry?.lastTo,
    provider: senderProvider,
  });
  let prompt = resolveHeartbeatPrompt(cfg, heartbeat);
  if (deliverySessionKey && deliverySessionKey !== sessionKey) {
    const channelContext = await buildHeartbeatChannelContext({
      cfg,
      sessionKey: deliverySessionKey,
    });
    if (channelContext) {
      prompt = `${channelContext}\n\n${prompt}`;
    }
  }
  const ctx = {
    Body: prompt,
    From: sender,
    To: sender,
    Provider: "heartbeat",
    SessionKey: sessionKey,
  };

  try {
    const replyResult = await getReplyFromConfig(ctx, { isHeartbeat: true }, cfg);
    const replyPayload = resolveHeartbeatReplyPayload(replyResult);
    const includeReasoning = heartbeat?.includeReasoning === true;
    const reasoningPayloads = includeReasoning
      ? resolveHeartbeatReasoningPayloads(replyResult).filter((payload) => payload !== replyPayload)
      : [];

    if (
      !replyPayload ||
      (!replyPayload.text && !replyPayload.mediaUrl && !replyPayload.mediaUrls?.length)
    ) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "ok-empty",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const ackMaxChars = resolveHeartbeatAckMaxChars(cfg, heartbeat);
    const normalized = normalizeHeartbeatReply(
      replyPayload,
      resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
      ackMaxChars,
    );
    const shouldSkipMain = normalized.shouldSkip && !normalized.hasMedia;
    if (shouldSkipMain && reasoningPayloads.length === 0) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "ok-token",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const mediaUrls =
      replyPayload.mediaUrls ?? (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []);

    // Suppress duplicate heartbeats (same payload) within a short window.
    // This prevents "nagging" when nothing changed but the model repeats the same items.
    const prevHeartbeatText =
      typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
    const prevHeartbeatAt =
      typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : undefined;
    const isDuplicateMain =
      !shouldSkipMain &&
      !mediaUrls.length &&
      Boolean(prevHeartbeatText.trim()) &&
      normalized.text.trim() === prevHeartbeatText.trim() &&
      typeof prevHeartbeatAt === "number" &&
      startedAt - prevHeartbeatAt < 24 * 60 * 60 * 1000;

    if (isDuplicateMain) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "skipped",
        reason: "duplicate",
        preview: normalized.text.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: false,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    // Reasoning payloads are text-only; any attachments stay on the main reply.
    const previewText = shouldSkipMain
      ? reasoningPayloads
          .map((payload) => payload.text)
          .filter((text): text is string => Boolean(text?.trim()))
          .join("\n")
      : normalized.text;

    if (delivery.channel === "none" || !delivery.to) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: delivery.reason ?? "no-target",
        preview: previewText?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const deliveryAccountId = delivery.accountId;
    const heartbeatPlugin = getChannelPlugin(delivery.channel);
    if (heartbeatPlugin?.heartbeat?.checkReady) {
      const readiness = await heartbeatPlugin.heartbeat.checkReady({
        cfg,
        accountId: deliveryAccountId,
        deps: opts.deps,
      });
      if (!readiness.ok) {
        emitHeartbeatEvent({
          status: "skipped",
          reason: readiness.reason,
          preview: previewText?.slice(0, 200),
          durationMs: Date.now() - startedAt,
          hasMedia: mediaUrls.length > 0,
        });
        log.info("heartbeat: channel not ready", {
          channel: delivery.channel,
          reason: readiness.reason,
        });
        return { status: "skipped", reason: readiness.reason };
      }
    }

    await deliverOutboundPayloads({
      cfg,
      channel: delivery.channel,
      to: delivery.to,
      accountId: deliveryAccountId,
      payloads: [
        ...reasoningPayloads,
        ...(shouldSkipMain
          ? []
          : [
              {
                text: normalized.text,
                mediaUrls,
              },
            ]),
      ],
      deps: opts.deps,
    });

    // Record last delivered heartbeat payload for dedupe.
    if (!shouldSkipMain && normalized.text.trim()) {
      const store = loadSessionStore(storePath);
      const current = store[sessionKey];
      if (current) {
        store[sessionKey] = {
          ...current,
          lastHeartbeatText: normalized.text,
          lastHeartbeatSentAt: startedAt,
        };
        await saveSessionStore(storePath, store);
      }
    }

    if (!shouldSkipMain && normalized.text?.trim()) {
      if (deliverySessionKey && deliverySessionKey !== sessionKey) {
        await appendHeartbeatToDeliverySession({
          cfg,
          sessionKey: deliverySessionKey,
          text: normalized.text,
          nowMs: Date.now(),
        });
      }
    }

    emitHeartbeatEvent({
      status: "sent",
      to: delivery.to,
      preview: previewText?.slice(0, 200),
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
    });
    return { status: "ran", durationMs: Date.now() - startedAt };
  } catch (err) {
    const reason = formatErrorMessage(err);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
    });
    log.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  }
}

export function startHeartbeatRunner(opts: {
  cfg?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}) {
  const cfg = opts.cfg ?? loadConfig();
  const heartbeatAgents = resolveHeartbeatAgents(cfg);
  const intervals = heartbeatAgents
    .map((agent) => resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat))
    .filter((value): value is number => typeof value === "number");
  const intervalMs = intervals.length > 0 ? Math.min(...intervals) : null;
  if (!intervalMs) {
    log.info("heartbeat: disabled", { enabled: false });
  }

  const runtime = opts.runtime ?? defaultRuntime;
  const lastRunByAgent = new Map<string, number>();
  const run: HeartbeatWakeHandler = async (params) => {
    if (!heartbeatsEnabled) {
      return { status: "skipped", reason: "disabled" } satisfies HeartbeatRunResult;
    }
    if (heartbeatAgents.length === 0) {
      return { status: "skipped", reason: "disabled" } satisfies HeartbeatRunResult;
    }

    const reason = params?.reason;
    const isInterval = reason === "interval";
    const startedAt = Date.now();
    const now = startedAt;
    let ran = false;

    for (const agent of heartbeatAgents) {
      const agentIntervalMs = resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat);
      if (!agentIntervalMs) continue;
      const lastRun = lastRunByAgent.get(agent.agentId);
      if (isInterval && typeof lastRun === "number" && now - lastRun < agentIntervalMs) {
        continue;
      }

      const res = await runHeartbeatOnce({
        cfg,
        agentId: agent.agentId,
        heartbeat: agent.heartbeat,
        reason,
        deps: { runtime },
      });
      if (res.status === "skipped" && res.reason === "requests-in-flight") {
        return res;
      }
      if (res.status !== "skipped" || res.reason !== "disabled") {
        lastRunByAgent.set(agent.agentId, now);
      }
      if (res.status === "ran") ran = true;
    }

    if (ran) return { status: "ran", durationMs: Date.now() - startedAt };
    return { status: "skipped", reason: isInterval ? "not-due" : "disabled" };
  };

  setHeartbeatWakeHandler(async (params) => run({ reason: params.reason }));

  let timer: NodeJS.Timeout | null = null;
  if (intervalMs) {
    timer = setInterval(() => {
      requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });
    }, intervalMs);
    timer.unref?.();
    log.info("heartbeat: started", { intervalMs });
  }

  const cleanup = () => {
    setHeartbeatWakeHandler(null);
    if (timer) clearInterval(timer);
    timer = null;
  };

  opts.abortSignal?.addEventListener("abort", cleanup, { once: true });

  return { stop: cleanup };
}
