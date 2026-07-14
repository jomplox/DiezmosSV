import { lstatSync } from "node:fs";
import { resolve } from "node:path";

export function assertPrivateEnvFile(path, options = {}) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Environment file not found: ${path}`);
    }
    throw error;
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Environment path must be a regular non-symlink file: ${path}`);
  }

  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Environment file must be owned by the current user: ${path}`);
    }
    const approvedReadableFixture = options.allowReadableFixturePath
      ? resolve(path) === resolve(options.allowReadableFixturePath)
      : false;
    if ((stat.mode & 0o077) !== 0 && !approvedReadableFixture) {
      throw new Error(`Environment file must use owner-only permissions (chmod 600): ${path}`);
    }
  }
}
