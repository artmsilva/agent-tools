import * as fs from "node:fs";

/** Read a file safely, returning null on error. */
export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Read + JSON.parse a file safely, returning null on error. */
export function readJsonSafe(filePath: string): unknown {
  const content = readFileSafe(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

/** Check if a path is an existing directory. */
export function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/** Check if a path is an existing file. */
export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** List directory entry names of a given kind, [] on error. */
export function listDirNames(dirPath: string, kind: "dir" | "file" | "any" = "any"): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (kind === "dir") return entry.isDirectory();
        if (kind === "file") return entry.isFile() || entry.isSymbolicLink();
        return true;
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
