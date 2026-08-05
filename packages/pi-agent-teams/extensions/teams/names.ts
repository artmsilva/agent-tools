/**
 * Shared name sanitization.
 *
 * Must be stable across leader/worker/mailbox so file paths and mailbox ids match.
 */
export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Pool of person names for auto-generated comrades (soviet style). */
export const COMRADE_NAME_POOL: readonly string[] = [
	"ivan",
	"natasha",
	"boris",
	"olga",
	"dmitri",
	"katya",
	"sergei",
	"anya",
	"nikolai",
	"mila",
	"viktor",
	"lena",
	"pavel",
	"zoya",
	"alexei",
	"daria",
	"yuri",
	"vera",
	"andrei",
	"sonya",
	"maxim",
	"nina",
	"roman",
	"tanya",
	"leon",
	"irina",
	"oleg",
	"nadia",
	"artem",
	"lydia",
];

/** Pool of pirate-ish names for auto-generated mateys (pirate style). */
export const PIRATE_NAME_POOL: readonly string[] = [
	"blackbeard",
	"anne-bonny",
	"calico-jack",
	"mary-read",
	"long-john",
	"redbeard",
	"silver",
	"bones",
	"hook",
	"sparrow",
	"gibbs",
	"barbossa",
	"rackham",
	"flint",
	"morgan",
	"teach",
];

/**
 * Pick `count` names from the pool that aren't already taken.
 * Falls back to `<name>-2`, `<name>-3` etc. if pool is exhausted.
 */
export function pickNamesFromPool(opts: {
	pool: readonly string[];
	count: number;
	taken: ReadonlySet<string>;
	fallbackBase: string;
}): string[] {
	const { pool, count, taken, fallbackBase } = opts;
	const available = pool.filter((n) => !taken.has(n));
	const picked: string[] = [];

	for (let i = 0; i < count; i++) {
		const avail = available[i];
		if (avail !== undefined) {
			picked.push(avail);
			continue;
		}

		// Exhaust pool: append suffix to cycle through names again
		const base = pool.length > 0 ? (pool[i % pool.length] ?? fallbackBase) : fallbackBase;
		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (taken.has(candidate) || picked.includes(candidate)) {
			suffix++;
			candidate = `${base}-${suffix}`;
		}
		picked.push(candidate);
	}

	return picked;
}

export function pickComradeNames(count: number, taken: ReadonlySet<string>): string[] {
	return pickNamesFromPool({ pool: COMRADE_NAME_POOL, count, taken, fallbackBase: "comrade" });
}

export function pickPirateNames(count: number, taken: ReadonlySet<string>): string[] {
	return pickNamesFromPool({ pool: PIRATE_NAME_POOL, count, taken, fallbackBase: "matey" });
}

/**
 * Deterministic default names for normal style.
 * Produces agent1, agent2, ... skipping taken.
 */
export function pickAgentNames(count: number, taken: ReadonlySet<string>): string[] {
	const picked: string[] = [];
	let i = 1;
	while (picked.length < count) {
		const candidate = `agent${i}`;
		i++;
		if (taken.has(candidate) || picked.includes(candidate)) continue;
		picked.push(candidate);
	}
	return picked;
}
