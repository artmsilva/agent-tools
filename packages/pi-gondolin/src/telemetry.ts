/**
 * Boot-time telemetry.
 *
 * `performance.now()` returns milliseconds since the pi process started (its
 * time origin), so every mark is "ms since `pi` was invoked". We record the
 * milestones between process start and the sandbox being usable, and append a
 * structured summary to a JSONL log:
 *
 *   extension_loaded  — this extension's factory ran (pi is well into startup)
 *   session_start     — the interactive session started (≈ pi rendered the prompt)
 *   vm_boot_start     — VM.create called
 *   vm_created        — guest reached readiness
 *   provisioned       — apk/dotfiles/git provisioning finished
 *   vm_ready          — shell probed; sandbox fully usable
 *   first_prompt      — first user turn began
 *
 * Disable with GONDOLIN_TELEMETRY=0.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export interface Mark {
	name: string;
	atMs: number;
}

export interface TimelineRow {
	name: string;
	atMs: number;
	deltaMs: number;
}

export class Telemetry {
	readonly #marks: Mark[] = [];
	readonly #logFile: string;
	readonly #enabled: boolean;

	constructor(logFile: string, enabled = true) {
		this.#logFile = logFile;
		this.#enabled = enabled;
	}

	/** Milliseconds since the pi process started (≈ since `pi` was invoked). */
	static sinceStart(): number {
		return Math.round(performance.now());
	}

	/** Whether a milestone has already been recorded. */
	has(name: string): boolean {
		return this.#marks.some((m) => m.name === name);
	}

	/** Record a milestone once. Returns its recorded ms-since-start. */
	mark(name: string): number {
		const existing = this.#marks.find((m) => m.name === name);
		if (existing) return existing.atMs;
		const atMs = Telemetry.sinceStart();
		this.#marks.push({ name, atMs });
		return atMs;
	}

	/** Per-milestone deltas (time spent since the previous mark). */
	timeline(): TimelineRow[] {
		let prev = 0;
		return this.#marks.map((m) => {
			const deltaMs = m.atMs - prev;
			prev = m.atMs;
			return { name: m.name, atMs: m.atMs, deltaMs };
		});
	}

	/** ms from process start to the last mark. */
	totalMs(): number {
		const last = this.#marks.at(-1);
		return last ? last.atMs : 0;
	}

	/** ms between two recorded marks (undefined if either is missing). */
	between(from: string, to: string): number | undefined {
		const a = this.#marks.find((m) => m.name === from);
		const b = this.#marks.find((m) => m.name === to);
		return a && b ? b.atMs - a.atMs : undefined;
	}

	/** Human-readable timeline block. */
	format(): string {
		return this.timeline()
			.map((t) => `  ${t.name.padEnd(16)} +${String(t.deltaMs).padStart(6)}ms   @${String(t.atMs).padStart(6)}ms`)
			.join("\n");
	}

	/** Append a one-off structured event to the log. */
	event(type: string, data: Record<string, unknown> = {}): void {
		this.#write({ event: type, sinceStartMs: Telemetry.sinceStart(), ...data });
	}

	/** Append the full boot timeline to the log. */
	flushBoot(data: Record<string, unknown> = {}): void {
		this.#write({
			event: "boot",
			totalMs: this.totalMs(),
			renderMs: this.between("extension_loaded", "session_start") ?? null,
			vmBootMs: this.between("vm_boot_start", "vm_ready") ?? null,
			marks: this.timeline(),
			...data,
		});
	}

	#write(obj: Record<string, unknown>): void {
		if (!this.#enabled) return;
		try {
			mkdirSync(path.dirname(this.#logFile), { recursive: true });
			appendFileSync(this.#logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`);
		} catch {
			// telemetry must never break the session
		}
	}
}
