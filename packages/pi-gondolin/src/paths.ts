/**
 * Host <-> guest path mapping.
 *
 * The host working directory is mounted at {@link GUEST_WORKSPACE}. Absolute
 * host paths that live under the workspace are rewritten into the guest;
 * everything else is treated as an already-guest absolute path.
 */
import path from "node:path";

export const GUEST_WORKSPACE = "/workspace";

/** Guest HOME. The example leaked the host HOME (/Users/...); we pin /root. */
export const GUEST_HOME = "/root";

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

export function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

/**
 * Translate a tool-supplied path (absolute or relative, optionally @-prefixed)
 * into the guest filesystem namespace.
 */
export function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}
