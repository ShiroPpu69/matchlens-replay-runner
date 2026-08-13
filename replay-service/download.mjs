import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const MAX_REPLAY_BYTES = 300_000_000;
const MAX_ATTEMPTS = 4;

export function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value ?? "");
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? null : Number(match[3]) };
}

async function currentSize(path) {
  try { return (await stat(path)).size; } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function candidateUrls(value) {
  const urls = [value];
  if (value.startsWith("https://")) urls.push(value.replace(/^https:/, "http:"));
  return urls;
}

export async function downloadReplay(replayUrl, destination, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console;
  const urls = candidateUrls(replayUrl);
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    let offset = await currentSize(destination);
    if (offset > MAX_REPLAY_BYTES) throw new Error("replay exceeds 300 MB limit");
    const requestUrl = urls[(attempt - 1) % urls.length];
    try {
      const response = await fetchImpl(requestUrl, {
        headers: offset ? { Range: `bytes=${offset}-` } : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status === 416) {
        await rm(destination, { force: true });
        throw new Error("replay server rejected resume range; restarting download");
      }
      if (!response.ok || !response.body) throw new Error(`replay download returned ${response.status}`);

      let append = false;
      if (response.status === 206) {
        const range = parseContentRange(response.headers.get("content-range"));
        if (!range || range.start !== offset || range.end < range.start) {
          await rm(destination, { force: true });
          throw new Error("replay server returned an invalid resume range");
        }
        if (range.total !== null && range.total > MAX_REPLAY_BYTES) throw new Error("replay exceeds 300 MB limit");
        append = offset > 0;
      } else if (offset > 0) {
        offset = 0;
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 0 && offset + contentLength > MAX_REPLAY_BYTES) throw new Error("replay exceeds 300 MB limit");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: append ? "a" : "w" }));
      const finalSize = await currentSize(destination);
      if (finalSize > MAX_REPLAY_BYTES) throw new Error("replay exceeds 300 MB limit");
      if (contentLength > 0 && finalSize - offset !== contentLength) throw new Error(`replay download was truncated (${finalSize - offset}/${contentLength} bytes)`);
      if (finalSize < 8) throw new Error("replay download is empty or truncated");
      const durationMs = Date.now() - startedAt;
      log.log("[replay] download attempt completed", { attempt, resumedBytes: offset, compressedBytes: finalSize, durationMs, megabitsPerSecond: Number(((finalSize - offset) * 8 / Math.max(durationMs, 1) / 1000).toFixed(2)) });
      return { size: finalSize, attempts: attempt, resumedBytes: offset, durationMs };
    } catch (error) {
      lastError = error;
      log.warn("[replay] download attempt failed", { attempt, resumedBytes: offset, error: String(error) });
      if (attempt < MAX_ATTEMPTS) await delay(750 * 2 ** (attempt - 1));
    }
  }
  throw lastError ?? new Error("replay download failed");
}
