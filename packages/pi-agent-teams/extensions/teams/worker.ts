import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { popUnreadMessages, writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamsStyleFromEnv, type TeamsStyle, getTeamsStrings } from "./teams-style.js";
import {
	TEAM_CONTROL_NS,
	TEAM_MAILBOX_NS,
	isAbortRequestMessage,
	isPlanApprovedMessage,
	isPlanRejectedMessage,
	isSetSessionNameMessage,
	isShutdownRequestMessage,
	isTaskAssignmentMessage,
} from "./protocol.js";
import { getTeamDir } from "./paths.js";
import { ensureTeamConfig, setMemberStatus, upsertMember } from "./team-config.js";
import {
	claimNextAvailableTask,
	completeTask,
	getTask,
	isTaskBlocked,
	requeueTaskToPending,
	startAssignedTask,
	unassignTask,
	unassignTasksForAgent,
	updateTask,
	type TeamTask,
} from "./task-store.js";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function teamDirFromEnv(): {
	teamId: string;
	teamDir: string;
	taskListId: string;
	agentName: string;
	leadName: string;
	styleId: TeamsStyle;
	autoClaim: boolean;
} | null {
	const teamId = process.env.PI_TEAMS_TEAM_ID;
	const agentNameRaw = process.env.PI_TEAMS_AGENT_NAME;
	if (!teamId || !agentNameRaw) return null;

	const agentName = sanitizeName(agentNameRaw);
	const taskListId = process.env.PI_TEAMS_TASK_LIST_ID ?? teamId;
	const styleId = getTeamsStyleFromEnv(process.env);
	const leadName = sanitizeName(process.env.PI_TEAMS_LEAD_NAME ?? "team-lead");
	const autoClaim = (process.env.PI_TEAMS_AUTO_CLAIM ?? "1") === "1";

	return {
		teamId,
		teamDir: getTeamDir(teamId),
		taskListId,
		agentName,
		leadName,
		styleId,
		autoClaim,
	};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasProperty<K extends string>(value: unknown, key: K): value is Record<K, unknown> & Record<string, unknown> {
	return isObjectRecord(value) && key in value;
}

function hasStringProperty<K extends string>(value: unknown, key: K): value is Record<K, string> & Record<string, unknown> {
	return isObjectRecord(value) && typeof value[key] === "string";
}

type AssistantMessageWithContent = Record<"role", "assistant"> & Record<"content", unknown> & Record<string, unknown>;

function isAssistantMessageWithContent(message: unknown): message is AssistantMessageWithContent {
	return hasStringProperty(message, "role") && message.role === "assistant" && hasProperty(message, "content");
}

type TextBlock = { type: "text"; text: string };

function isTextBlock(block: unknown): block is TextBlock {
	return hasStringProperty(block, "type") && block.type === "text" && hasStringProperty(block, "text");
}

function extractLastAssistantText(messages: AgentMessage[]): string {
	const assistant = messages.filter((m) => isAssistantMessageWithContent(m));
	const last = assistant.at(-1);
	if (!last) return "";

	const content = last.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.filter((c) => isTextBlock(c)).map((c) => c.text).join("");
	}
	return "";
}

function buildTaskPrompt(style: TeamsStyle, agentName: string, task: TeamTask, planOnly = false): string {
	const strings = getTeamsStrings(style);
	const footer = planOnly
		? "Produce a detailed implementation plan only. Do NOT make any changes or implement anything yet. Your plan will be reviewed before you can proceed."
		: "Do the work now. When finished, reply with a concise summary and any key outputs.";

	const actor = strings.memberTitle.toLowerCase();
	return [
		`You are ${actor} '${agentName}'.`,
		`You have been assigned task #${task.id}.`,
		`Subject: ${task.subject}`,
		"",
		`Description:\n${task.description}`,
		"",
		footer,
	].join("\n");
}

const DEFAULT_COMPACT_THRESHOLD_PERCENT = 70;

/**
 * Resolve the context-usage percent (0-100) at which the worker should
 * compact before starting more work. Overridable via
 * PI_TEAMS_COMPACT_THRESHOLD_PERCENT; a value of 0 (or an invalid override)
 * disables compaction gating.
 */
export function getCompactThresholdPercent(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_TEAMS_COMPACT_THRESHOLD_PERCENT;
	if (raw === undefined || raw.trim() === "") return DEFAULT_COMPACT_THRESHOLD_PERCENT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_COMPACT_THRESHOLD_PERCENT;
	return parsed;
}

/** Pure predicate: should the worker compact before claiming/starting another task? */
export function shouldCompactBeforeNextTask(percent: number | null | undefined, thresholdPercent: number): boolean {
	if (thresholdPercent <= 0) return false; // 0 (or negative) disables compaction gating
	if (percent === null || percent === undefined) return false;
	return percent >= thresholdPercent;
}

type SendUserMessageFn = (
	content: string | { type: "text"; text: string }[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

/**
 * Attempt to deliver a message to the agent. Returns true if the call
 * completed without throwing, false otherwise. Callers must only mutate
 * local worker state (or clear queued content) after a true result, so a
 * failed delivery never silently drops a task assignment, plan decision, or
 * mailbox message.
 */
export function trySendUserMessage(
	sendUserMessage: SendUserMessageFn,
	content: string | { type: "text"; text: string }[],
	options?: { deliverAs?: "steer" | "followUp" },
): boolean {
	try {
		sendUserMessage(content, options);
		return true;
	} catch {
		return false;
	}
}

/** Plan approval: non-urgent, must never drop the leader's decision. */
export function sendPlanApprovedMessage(sendUserMessage: SendUserMessageFn): boolean {
	return trySendUserMessage(sendUserMessage, "Your plan has been approved. Proceed with implementation.", {
		deliverAs: "followUp",
	});
}

/** Plan rejection: non-urgent, must never drop the leader's decision. */
export function sendPlanRejectedMessage(sendUserMessage: SendUserMessageFn, feedback: string): boolean {
	return trySendUserMessage(
		sendUserMessage,
		`Your plan was rejected. Feedback: ${feedback}\nPlease revise your plan.`,
		{ deliverAs: "followUp" },
	);
}

/** Urgent mailbox messages retain steer delivery (they must interrupt the active turn). */
export function sendUrgentDmMessage(sendUserMessage: SendUserMessageFn, from: string, text: string): boolean {
	return trySendUserMessage(sendUserMessage, `[urgent message from ${from}] ${text}`, { deliverAs: "steer" });
}

export interface AssignedTaskDeliveryDeps {
	sendUserMessage: SendUserMessageFn;
	/** Reset the task back to pending (keeping ownership) so it isn't stranded in_progress. */
	requeueTaskToPending: (reason: string) => Promise<unknown>;
}

/**
 * Deliver an assigned-task prompt as a followUp. On failure, requeues the
 * task to pending (still owned by this agent) so it is not stranded
 * in_progress; the caller is responsible for re-queuing the taskId locally
 * so this worker retries it on a later poll cycle.
 */
export async function deliverAssignedTaskPrompt(deps: AssignedTaskDeliveryDeps, prompt: string): Promise<boolean> {
	if (trySendUserMessage(deps.sendUserMessage, prompt, { deliverAs: "followUp" })) return true;
	await deps.requeueTaskToPending("task prompt delivery failed");
	return false;
}

export interface AutoClaimedTaskDeliveryDeps {
	sendUserMessage: SendUserMessageFn;
	/** Release the claim (unassign + reset to pending) so the task returns to the shared pool. */
	unassignTask: (reason: string) => Promise<unknown>;
}

/**
 * Deliver an auto-claimed task prompt as a followUp. On failure, releases
 * the claim so the task is not stranded in_progress: it goes back to the
 * shared pool where it (or another worker) can claim it again later.
 */
export async function deliverAutoClaimedTaskPrompt(
	deps: AutoClaimedTaskDeliveryDeps,
	prompt: string,
): Promise<boolean> {
	if (trySendUserMessage(deps.sendUserMessage, prompt, { deliverAs: "followUp" })) return true;
	await deps.unassignTask("task prompt delivery failed");
	return false;
}

/**
 * Deliver queued DM text as a followUp. Returns false without dropping
 * anything on failure; callers must keep the queued text (never clear it
 * until delivery is accepted) so it is retried on a later poll cycle.
 */
export function deliverQueuedDmText(sendUserMessage: SendUserMessageFn, text: string): boolean {
	return trySendUserMessage(
		sendUserMessage,
		[
			{ type: "text", text: "You have received comrade message(s):" },
			{ type: "text", text },
		],
		{ deliverAs: "followUp" },
	);
}

/** Outcome of finalizing a settled run's active task. Computed once agent_settled fires. */
export type TaskFinalizeOutcome = { kind: "completed"; result: string } | { kind: "aborted"; metadata: Record<string, unknown> };

/**
 * Pure decision: how should a settled run's task outcome be recorded?
 * Reads the captured final assistant text (from the last agent_end before
 * settling) and any pending abort request, so callers never need to inspect
 * intermediate (possibly-retried) agent_end state directly.
 */
export function computeTaskFinalizeOutcome(
	messages: AgentMessage[],
	abort: { taskId: string | null; reason?: string; requestId: string | null },
	taskId: string,
): TaskFinalizeOutcome {
	const rawResult = extractLastAssistantText(messages);
	const trimmed = rawResult.trim();
	const abortedByRequest = abort.taskId === taskId;
	const aborted = abortedByRequest || trimmed.length === 0;

	if (!aborted) return { kind: "completed", result: rawResult };

	const metadata: Record<string, unknown> = { abortedAt: new Date().toISOString() };
	if (abortedByRequest) {
		if (abort.requestId) metadata.abortRequestId = abort.requestId;
		metadata.abortReason = abort.reason ?? "abort requested";
		if (trimmed.length > 0) metadata.partialResult = rawResult;
	} else {
		metadata.abortReason = "no assistant result";
	}
	return { kind: "aborted", metadata };
}

/**
 * Pure decision: when to notify the lead around a settled run.
 *
 * `notifyBeforeNextWork` fires immediately whenever a task just finished —
 * BEFORE any attempt to claim/start the next one — so chained auto-claimed
 * tasks cannot hide earlier completions from the lead's delegation tracking.
 * `notifyAfterNextWork` only fires when no task just finished and the
 * worker is still idle afterward (e.g. after handling DMs with nothing else
 * to do), matching the prior plain "idle ping" behavior.
 */
export function planIdleNotifications(input: {
	hadTask: boolean;
	isStreamingAfterNextWork: boolean;
	hasCurrentTaskAfterNextWork: boolean;
}): { notifyBeforeNextWork: boolean; notifyAfterNextWork: boolean } {
	return {
		notifyBeforeNextWork: input.hadTask,
		notifyAfterNextWork: !input.hadTask && !input.isStreamingAfterNextWork && !input.hasCurrentTaskAfterNextWork,
	};
}

export function loadWorkerSystemPrompt(teamDir: string, file: string | undefined): string {
	if (!file) return "";
	try {
		const teamDirReal = fs.realpathSync(teamDir);
		const fileReal = fs.realpathSync(file);
		const relative = path.relative(teamDirReal, fileReal);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
		if (fs.statSync(fileReal).size > 1024 * 1024) return "";
		return fs.readFileSync(fileReal, "utf8").trim();
	} catch {
		return "";
	}
}

// Message parsers are shared with the leader implementation.
export function runWorker(pi: ExtensionAPI): void {
	const env = teamDirFromEnv();
	if (!env) return;

	const { teamId, teamDir, taskListId, agentName, leadName, styleId, autoClaim } = env;
	const sendUserMessage: SendUserMessageFn = (content, options) => pi.sendUserMessage(content, options);
	const teammateSystemPrompt = loadWorkerSystemPrompt(teamDir, process.env.PI_TEAMS_SYSTEM_PROMPT_FILE);
	if (teammateSystemPrompt) {
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${teammateSystemPrompt}`,
		}));
	}

	// Prefer persisted team config style (leader-controlled) over env default.
	// This keeps manual workers consistent with the current team terminology.
	let style: TeamsStyle = styleId;

	const TeamMessageToolParamsSchema = Type.Object({
		recipient: Type.String({ description: "Name of the comrade to message" }),
		message: Type.String({ description: "The message to send" }),
		urgent: Type.Optional(Type.Boolean({
			description: "When true, the message interrupts the recipient's active turn via steering instead of waiting for idle. Use for time-sensitive coordination.",
		})),
	});
	// Match the schema at compile-time.
	type TeamMessageToolParams = Static<typeof TeamMessageToolParamsSchema>;
	// Tool result details to match AgentToolResult<TDetails> contract.
	type TeamMessageToolDetails = { recipient: string; timestamp: string; urgent: boolean };

	pi.registerTool({
		name: "team_message",
		label: "Team Message",
		description: "Send a message to a comrade. Use this to coordinate with peers on related tasks. Set urgent=true to interrupt their active turn (use sparingly — only for time-sensitive coordination).",
		promptSnippet: "Send a coordination message to another teammate, optionally as an urgent interruption.",
		promptGuidelines: [
			"Use this tool for teammate-to-teammate coordination instead of overloading task status fields with freeform messages.",
			"Set urgent=true only when the recipient must be interrupted before finishing their current turn.",
		],
		parameters: TeamMessageToolParamsSchema,
		async execute(
			_toolCallId,
			params: TeamMessageToolParams,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<TeamMessageToolDetails>> {
			const recipient = sanitizeName(params.recipient);
			const message = params.message;
			const isUrgent = params.urgent === true;
			const ts = new Date().toISOString();
			// Write to recipient's mailbox in team namespace
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, recipient, {
				from: agentName,
				text: message,
				timestamp: ts,
				...(isUrgent ? { urgent: true } : {}),
			});
			// CC leader with peer_dm_sent notification
			await writeToMailbox(teamDir, TEAM_CONTROL_NS, leadName, {
				from: agentName,
				text: JSON.stringify({
					type: "peer_dm_sent",
					from: agentName,
					to: recipient,
					summary: message.slice(0, 100),
					urgent: isUrgent,
					timestamp: ts,
				}),
				timestamp: ts,
			});
			return {
				content: [{ type: "text", text: `${isUrgent ? "Urgent message" : "Message"} sent to ${recipient}` }],
				details: { recipient, timestamp: ts, urgent: isUrgent },
			};
		},
	});

	let ctxRef: ExtensionContext | null = null;
	let isStreaming = false;
	let isDeciding = false;
	let currentTaskId: string | null = null;
	let pendingTaskAssignments: string[] = [];
	let pendingDmTexts: string[] = [];
	let pollAbort = false;
	let lastHeartbeatAt = 0;
	let shutdownInProgress = false;
	let lastAgentEndMessages: AgentMessage[] = [];
	let settleProcessed = false;
	let compactionInFlight = false;
	const seenShutdownRequestIds = new Set<string>();

	let abortTaskId: string | null = null;
	let abortReason: string | undefined;
	let abortRequestId: string | null = null;
	const seenAbortRequestIds = new Set<string>();

	// Plan-required mode
	let planMode = process.env.PI_TEAMS_PLAN_REQUIRED === "1";
	let planApproved = false;
	let planRequestId: string | null = null;
	/** Tools that were active before plan-mode restriction, so we can restore them on approval. */
	let prePlanTools: string[] | null = null;

	const poll = async () => {
		while (!pollAbort) {
			try {
				const now = Date.now();
				if (now - lastHeartbeatAt >= 5_000) {
					await setMemberStatus(teamDir, agentName, "online", { lastSeenAt: new Date(now).toISOString() });
					lastHeartbeatAt = now;
				}
				// Keep model-facing DMs separate from trusted lifecycle/completion protocol messages.
				const [teamMsgs, controlMsgs, taskMsgs] = await Promise.all([
					popUnreadMessages(teamDir, TEAM_MAILBOX_NS, agentName),
					popUnreadMessages(teamDir, TEAM_CONTROL_NS, agentName),
					popUnreadMessages(teamDir, taskListId, agentName),
				]);
				const controlMessageSet = new Set(controlMsgs);
				const taskMessageSet = new Set(taskMsgs);

				for (const m of [...controlMsgs, ...taskMsgs, ...teamMsgs]) {
					const isControlMessage = controlMessageSet.has(m);
					const isTaskMessage = taskMessageSet.has(m);
					if ((isControlMessage || isTaskMessage) && sanitizeName(m.from) !== sanitizeName(leadName)) continue;

					const shutdown = isControlMessage ? isShutdownRequestMessage(m.text) : null;
					if (shutdown && !seenShutdownRequestIds.has(shutdown.requestId)) {
						seenShutdownRequestIds.add(shutdown.requestId);

						const ts = new Date().toISOString();

						// Reject shutdown if currently busy (including plan-mode waiting for approval)
						if (currentTaskId) {
							await writeToMailbox(teamDir, TEAM_CONTROL_NS, leadName, {
								from: agentName,
								text: JSON.stringify({
									type: "shutdown_rejected",
									requestId: shutdown.requestId,
									from: agentName,
									reason: `Currently working on task #${currentTaskId}`,
									timestamp: ts,
								}),
								timestamp: ts,
							});
							continue;
						}

						// Idle — approve shutdown
						shutdownInProgress = true;
						pollAbort = true;

						await writeToMailbox(teamDir, TEAM_CONTROL_NS, leadName, {
							from: agentName,
							text: JSON.stringify({
								type: "shutdown_approved",
								requestId: shutdown.requestId,
								from: agentName,
								timestamp: ts,
							}),
							timestamp: ts,
						});

						try {
							await cleanup("shutdown requested");
						} catch {
							// ignore
						}

						try {
							ctxRef?.abort();
						} catch {
							// ignore
						}
						try {
							ctxRef?.shutdown();
						} catch {
							// ignore
						}
						return;
					}

					const setName = isControlMessage ? isSetSessionNameMessage(m.text) : null;
					if (setName) {
						const desired = setName.name.trim();
						if (desired) {
							try {
								const existing = pi.getSessionName?.();
								// Only overwrite sessions that are unnamed or already managed by us.
								if (!existing || existing.startsWith("pi agent teams -")) {
									if (existing !== desired) pi.setSessionName(desired);
								}
							} catch {
								// ignore
							}
						}
						continue;
					}

					const abortReq = isControlMessage ? isAbortRequestMessage(m.text) : null;
					if (abortReq && !seenAbortRequestIds.has(abortReq.requestId)) {
						seenAbortRequestIds.add(abortReq.requestId);

						// If the request targets a specific task and we're busy on a different one, ignore.
						if (abortReq.taskId && currentTaskId && abortReq.taskId !== currentTaskId) continue;

						if (currentTaskId) {
							abortTaskId = currentTaskId;
							abortReason = abortReq.reason;
							abortRequestId = abortReq.requestId;
						}

						try {
							ctxRef?.abort();
						} catch {
							// ignore
						}
						continue;
					}

					// Plan approval/rejection handling
					const planApproval = isControlMessage ? isPlanApprovedMessage(m.text) : null;
					if (planApproval && planRequestId && planApproval.requestId === planRequestId) {
						pi.setActiveTools(prePlanTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]);
						prePlanTools = null;
						planApproved = true;
						planMode = false;
						planRequestId = null;
						if (!sendPlanApprovedMessage(sendUserMessage)) {
							pendingDmTexts.push("Your plan has been approved. Proceed with implementation.");
						}
						continue;
					}

					const planRejection = isControlMessage ? isPlanRejectedMessage(m.text) : null;
					if (planRejection && planRequestId && planRejection.requestId === planRequestId) {
						planRequestId = null;
						if (!sendPlanRejectedMessage(sendUserMessage, planRejection.feedback)) {
							pendingDmTexts.push(
								`Your plan was rejected. Feedback: ${planRejection.feedback}\nPlease revise your plan.`,
							);
						}
						continue;
					}

					const assign = isTaskMessage ? isTaskAssignmentMessage(m.text) : null;
					if (assign) {
						pendingTaskAssignments.push(assign.taskId);
						continue;
					}

					// Unknown control/task payloads are never forwarded into the model as DMs.
					if (isControlMessage || isTaskMessage) continue;

					// Urgent DMs interrupt the active turn via steer; normal DMs queue for idle.
					// Never drop the message: if steer delivery fails, fall back to queuing it
					// like a normal DM so it is retried on a later idle cycle.
					if (m.urgent && isStreaming) {
						if (!sendUrgentDmMessage(sendUserMessage, m.from, m.text)) {
							pendingDmTexts.push(`[message from ${m.from}] ${m.text}`);
						}
					} else {
						pendingDmTexts.push(m.text);
					}
				}

				if (!shutdownInProgress) await maybeStartNextWork();
			} catch {
				// ignore polling errors
			}

			// Add a little jitter to avoid all workers polling/claiming in lock-step.
			await sleep(350 + Math.floor(Math.random() * 200));
		}
	};

	const maybeStartNextWork = async () => {
		if (!ctxRef) return;
		if (shutdownInProgress || compactionInFlight) return;
		if (isStreaming) return;
		if (isDeciding) return;

		isDeciding = true;
		try {
			// A plan decision continues the current task, so it may be delivered
			// while currentTaskId is still set.
			if (currentTaskId && pendingDmTexts.length) {
				const text = pendingDmTexts.join("\n\n---\n\n");
				if (deliverQueuedDmText(sendUserMessage, text)) {
					pendingDmTexts = [];
					isStreaming = true;
				}
				return;
			}
			if (currentTaskId) return;

			// 1) Assigned tasks
			const requeue: string[] = [];
			while (pendingTaskAssignments.length) {
				const taskId = pendingTaskAssignments.shift();
				if (!taskId) break;
				const task = await getTask(teamDir, taskListId, taskId);
				if (!task) continue;
				if (task.owner !== agentName) continue;
				if (task.status === "completed") continue;

				// Respect deps: don't start assigned tasks until unblocked.
				if (await isTaskBlocked(teamDir, taskListId, task)) {
					requeue.push(taskId);
					continue;
				}

				// Mark in_progress if needed
				if (task.status === "pending") await startAssignedTask(teamDir, taskListId, taskId, agentName);

				currentTaskId = taskId;
				const delivered = await deliverAssignedTaskPrompt(
					{
						sendUserMessage,
						requeueTaskToPending: (reason) =>
							requeueTaskToPending(teamDir, taskListId, taskId, agentName, reason),
					},
					buildTaskPrompt(style, agentName, task, planMode && !planApproved),
				);
				if (delivered) {
					isStreaming = true; // optimistic; agent_start will follow
					pendingTaskAssignments = [...requeue, ...pendingTaskAssignments];
					return;
				}
				currentTaskId = null;
				isStreaming = false;
				requeue.unshift(taskId);
			}
			pendingTaskAssignments = [...requeue, ...pendingTaskAssignments];

			// 2) DMs
			if (pendingDmTexts.length) {
				const text = pendingDmTexts.join("\n\n---\n\n");
				if (deliverQueuedDmText(sendUserMessage, text)) {
					pendingDmTexts = [];
					isStreaming = true;
				}
				return;
			}

			// 3) Auto-claim
			if (autoClaim) {
				// Small randomized delay improves fairness (reduces one fast worker hogging tasks)
				// and reduces lock contention when many workers become idle simultaneously.
				await sleep(Math.floor(Math.random() * 250));

				const claimed = await claimNextAvailableTask(teamDir, taskListId, agentName, { checkAgentBusy: true });
				if (claimed) {
					currentTaskId = claimed.id;
					const delivered = await deliverAutoClaimedTaskPrompt(
						{
							sendUserMessage,
							unassignTask: (reason) =>
								unassignTask(teamDir, taskListId, claimed.id, agentName, reason),
						},
						buildTaskPrompt(style, agentName, claimed, planMode && !planApproved),
					);
					if (delivered) {
						isStreaming = true;
						return;
					}
					currentTaskId = null;
					isStreaming = false;
				}
			}
		} finally {
			isDeciding = false;
		}
	};

	const sendIdleNotification = async (
		completedTaskId?: string,
		completedStatus?: "completed" | "failed",
		failureReason?: string,
	) => {
		type IdleNotificationPayload = {
			type: "idle_notification";
			from: string;
			timestamp: string;
			completedTaskId?: string;
			completedStatus?: "completed" | "failed";
			failureReason?: string;
		};

		const payload: IdleNotificationPayload = {
			type: "idle_notification",
			from: agentName,
			timestamp: new Date().toISOString(),
		};
		if (completedTaskId) payload.completedTaskId = completedTaskId;
		if (completedStatus) payload.completedStatus = completedStatus;
		if (failureReason) payload.failureReason = failureReason;

		await writeToMailbox(teamDir, TEAM_CONTROL_NS, leadName, {
			from: agentName,
			text: JSON.stringify(payload),
			timestamp: new Date().toISOString(),
		});
	};

	const cleanup = async (reason: string) => {
		try {
			await unassignTasksForAgent(teamDir, taskListId, agentName, reason);
		} catch {
			// ignore
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;

		// Restrict tools in plan-required mode (read-only until plan is approved)
		if (planMode) {
			prePlanTools = pi.getActiveTools?.() ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
			pi.setActiveTools(["read", "grep", "find", "ls"]);
		}

		// Register ourselves in the shared team config so manual tmux workers are discoverable.
		try {
			const cfg = await ensureTeamConfig(teamDir, { teamId, taskListId, leadName, style: styleId });
			style = cfg.style ?? styleId;
			const now = new Date().toISOString();
			if (!cfg.members.some((m) => m.name === agentName)) {
				await upsertMember(teamDir, {
					name: agentName,
					role: "worker",
					status: "online",
					lastSeenAt: now,
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
				});
			} else {
				await setMemberStatus(teamDir, agentName, "online", { lastSeenAt: now });
			}
		} catch {
			// ignore config errors
		}

		void poll();
		await maybeStartNextWork();
		// Claude-style: let the leader know we're idle even if no task was completed yet.
		if (!isStreaming && !currentTaskId) {
			await sendIdleNotification();
		}
	});

	pi.on("session_shutdown", async () => {
		pollAbort = true;
		await cleanup("worker shutdown");
		try {
			await setMemberStatus(teamDir, agentName, "offline", { meta: { offlineReason: "worker shutdown" } });
		} catch {
			// ignore
		}
		await sendIdleNotification(undefined, undefined, "worker shutdown");
	});

	pi.on("agent_start", async () => {
		isStreaming = true;
		settleProcessed = false;
	});

	pi.on("agent_end", async (event) => {
		lastAgentEndMessages = event.messages;
	});

	pi.on("agent_settled", async () => {
		if (settleProcessed || shutdownInProgress) return;
		settleProcessed = true;
		isStreaming = false;

		// Plan submission waits for the fully settled turn, so retries and queued
		// continuations cannot submit or finalize the same task twice.
		if (planMode && !planApproved && currentTaskId && !planRequestId) {
			const reqId = randomUUID();
			planRequestId = reqId;
			const timestamp = new Date().toISOString();
			await writeToMailbox(teamDir, TEAM_CONTROL_NS, leadName, {
				from: agentName,
				text: JSON.stringify({
					type: "plan_approval_request",
					requestId: reqId,
					from: agentName,
					plan: extractLastAssistantText(lastAgentEndMessages),
					taskId: currentTaskId,
					timestamp,
				}),
				timestamp,
			});
			return;
		}

		const taskId = currentTaskId;
		currentTaskId = null;
		let completedStatus: "completed" | "failed" | undefined;
		let failureReason: string | undefined;

		try {
			if (taskId) {
				const outcome = computeTaskFinalizeOutcome(
					lastAgentEndMessages,
					{ taskId: abortTaskId, reason: abortReason, requestId: abortRequestId },
					taskId,
				);
				if (outcome.kind === "completed") {
					await completeTask(teamDir, taskListId, taskId, agentName, outcome.result);
					completedStatus = "completed";
				} else {
					await updateTask(teamDir, taskListId, taskId, (cur) => {
						if (cur.owner !== agentName || cur.status === "completed") return cur;
						return {
							...cur,
							status: "pending",
							metadata: { ...(cur.metadata ?? {}), ...outcome.metadata, abortedBy: agentName },
						};
					});
					completedStatus = "failed";
					failureReason = String(outcome.metadata.abortReason ?? "task aborted");
				}
			}
		} finally {
			abortTaskId = null;
			abortReason = undefined;
			abortRequestId = null;
		}

		const notifications = planIdleNotifications({
			hadTask: taskId !== null,
			isStreamingAfterNextWork: false,
			hasCurrentTaskAfterNextWork: false,
		});
		if (notifications.notifyBeforeNextWork && taskId) {
			await sendIdleNotification(taskId, completedStatus, failureReason);
		}

		const continueWork = async () => {
			await maybeStartNextWork();
			const after = planIdleNotifications({
				hadTask: taskId !== null,
				isStreamingAfterNextWork: isStreaming,
				hasCurrentTaskAfterNextWork: currentTaskId !== null,
			});
			if (after.notifyAfterNextWork) await sendIdleNotification();
		};

		const usagePercent = ctxRef?.getContextUsage()?.percent;
		const threshold = getCompactThresholdPercent();
		if (
			taskId &&
			completedStatus === "completed" &&
			ctxRef &&
			!compactionInFlight &&
			shouldCompactBeforeNextTask(usagePercent, threshold)
		) {
			compactionInFlight = true;
			const resume = () => {
				compactionInFlight = false;
				void continueWork();
			};
			ctxRef.compact({
				customInstructions:
					"Retain the team role, shared task protocol, reusable project facts, and current decisions. Drop completed-task implementation detail.",
				onComplete: resume,
				onError: resume,
			});
			return;
		}

		await continueWork();
	});

	// Best-effort cleanup on SIGTERM (leader kill).
	process.on("SIGTERM", () => {
		pollAbort = true;
		void (async () => {
			await cleanup("SIGTERM");
			try {
				await setMemberStatus(teamDir, agentName, "offline", { meta: { offlineReason: "SIGTERM" } });
			} catch {
				// ignore
			}
			await sendIdleNotification(undefined, undefined, "SIGTERM");
		})().finally(() => process.exit(0));
	});
}
