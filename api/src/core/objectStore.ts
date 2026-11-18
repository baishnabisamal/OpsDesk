import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

// Object storage: put a file under a key, read it back.
//
// This version keeps the files in a local directory (ARCHIVE_DIR). The README
// planned MinIO, an S3-compatible server. Only this file would change: the
// rest of the code calls putObject / openObject and does not know where the
// bytes live.

function fullPath(key: string): string {
  // Keys are made by the code, but check anyway that one cannot climb out of
  // the archive directory with "../".
  const resolved = path.resolve(config.archiveDir, key);
  if (!resolved.startsWith(path.resolve(config.archiveDir) + path.sep)) {
    throw new Error(`bad object key: ${key}`);
  }
  return resolved;
}

// Writes the stream to `key`. It writes to a temporary name first and renames
// at the end: a rename is atomic, so a crash half way never leaves a file
// that looks complete but is cut short.
export async function putObject(key: string, content: Readable): Promise<void> {
  const target = fullPath(key);
  const temporary = `${target}.partial`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(content, createWriteStream(temporary));
    await rename(temporary, target);
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }
}

export function openObject(key: string): Readable {
  return createReadStream(fullPath(key));
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await stat(fullPath(key));
    return true;
  } catch {
    return false;
  }
}
