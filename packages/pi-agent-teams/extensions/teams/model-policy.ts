const SONNET4_DEPRECATED_MARKER = "claude-sonnet-4";
const SONNET45_ALLOWED_MARKERS = ["claude-sonnet-4-5", "claude-sonnet-4.5"];

function normalizeModelId(modelId: string): string {
	return modelId.trim().toLowerCase();
}

function hasAnyMarker(value: string, markers: readonly string[]): boolean {
	for (const marker of markers) {
		if (value.includes(marker)) return true;
	}
	return false;
}

function trimOrUndefined(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function isDeprecatedTeammateModelId(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	if (!normalized) return false;
	if (!normalized.includes(SONNET4_DEPRECATED_MARKER)) return false;
	if (hasAnyMarker(normalized, SONNET45_ALLOWED_MARKERS)) return false;

	const idx = normalized.indexOf(SONNET4_DEPRECATED_MARKER);
	const next = normalized.at(idx + SONNET4_DEPRECATED_MARKER.length);
	if (!next) return true;
	return next === "-" || next === "_" || next === "." || next === ":";
}

export type TeammateModelSource = "override" | "inherit_leader" | "default";

export interface ResolvedTeammateModel {
	source: TeammateModelSource;
	provider?: string;
	modelId?: string;
	warnings: string[];
}

export type ResolveTeammateModelResult =
	| {
			ok: true;
			value: ResolvedTeammateModel;
	  }
	| {
			ok: false;
			error: string;
			reason: "invalid_override" | "deprecated_override";
	  };

export function formatProviderModel(provider: string | undefined, modelId: string | undefined): string | null {
	if (!modelId) return null;
	return provider ? `${provider}/${modelId}` : modelId;
}

export function resolveTeammateModelSelection(input: {
	modelOverride?: string;
	leaderProvider?: string;
	leaderModelId?: string;
}): ResolveTeammateModelResult {
	const override = trimOrUndefined(input.modelOverride);
	if (override) {
		const slashIdx = override.indexOf("/");
		if (slashIdx >= 0) {
			const provider = override.slice(0, slashIdx).trim();
			const id = override.slice(slashIdx + 1).trim();
			if (!provider || !id) {
				return {
					ok: false,
					reason: "invalid_override",
					error: `Invalid model override '${override}'. Expected <provider>/<modelId>.`,
				};
			}
			if (isDeprecatedTeammateModelId(id)) {
				return {
					ok: false,
					reason: "deprecated_override",
					error: `Model override '${override}' is deprecated. Choose a current model id.`,
				};
			}
			return {
				ok: true,
				value: {
					source: "override",
					provider,
					modelId: id,
					warnings: [],
				},
			};
		}

		if (isDeprecatedTeammateModelId(override)) {
			return {
				ok: false,
				reason: "deprecated_override",
				error: `Model override '${override}' is deprecated. Choose a current model id.`,
			};
		}

		const leaderProvider = trimOrUndefined(input.leaderProvider);
		const warnings: string[] = [];
		if (!leaderProvider) {
			warnings.push(
				`Model override '${override}' provided without a provider. ` +
					`Teammate will use its default provider; use <provider>/<modelId> to force one.`,
			);
		}
		return {
			ok: true,
			value: {
				source: "override",
				provider: leaderProvider,
				modelId: override,
				warnings,
			},
		};
	}

	const leaderModelId = trimOrUndefined(input.leaderModelId);
	const leaderProvider = trimOrUndefined(input.leaderProvider);
	if (leaderModelId && !isDeprecatedTeammateModelId(leaderModelId)) {
		return {
			ok: true,
			value: {
				source: "inherit_leader",
				provider: leaderProvider,
				modelId: leaderModelId,
				warnings: [],
			},
		};
	}

	return {
		ok: true,
		value: {
			source: "default",
			warnings: [],
		},
	};
}
