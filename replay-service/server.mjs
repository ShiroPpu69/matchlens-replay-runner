import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import readline from "node:readline";
import { promisify } from "node:util";
import { extractReplayData } from "./extract.mjs";
import { detectReplayCompression, replayCompression } from "./replay-format.mjs";
import { downloadReplay } from "./download.mjs";

const exec = promisify(execFile);
const port = Number(process.env.PORT || 8080);
const token = process.env.SERVICE_TOKEN || "";
const callbackToken = process.env.CALLBACK_TOKEN || "";
const sitesBypassToken = process.env.SITES_BYPASS_TOKEN || "";
const callbackBaseUrl = (process.env.CALLBACK_BASE_URL || "").replace(/\/$/, "");
const parserUrl = process.env.PARSER_URL || "http://127.0.0.1:5600/";
const dataDir = process.env.DATA_DIR || "/data";
const storePath = join(dataDir, "jobs.json");
const resultSchemaVersion = "2.1.0";
const jobs = new Map();
let running = false;

await mkdir(dataDir, { recursive: true });
try {
  const saved = JSON.parse(await readFile(storePath, "utf8"));
  for (const job of saved) jobs.set(job.id, job.status === "running" ? { ...job, status: "queued" } : job);
} catch {}

async function persist() {
  const temp = `${storePath}.tmp`;
  await writeFile(temp, JSON.stringify([...jobs.values()], null, 2));
  await rename(temp, storePath);
}

function validReplayUrl(value, matchId) {
  try {
    const url = new URL(value);
    const globalHost = /^replay\d+\.valve\.net$/i.test(url.hostname);
    const chinaHost = /^replay(?:413|415|417)\.dota2\.com\.cn$/i.test(url.hostname);
    return ["http:", "https:"].includes(url.protocol)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && (globalHost || chinaHost)
      && new RegExp(`^/570/${matchId}_\\d+\\.dem\\.bz2$`, "i").test(url.pathname);
  } catch { return false; }
}

async function parseReplay(job) {
  const dir = join(tmpdir(), `dota-replay-${job.id}`);
  await mkdir(dir, { recursive: true });
  const downloaded = join(dir, "match.download");
  const replay = join(dir, "match.dem");
  const timings = {};
  let stageStarted = Date.now();
  const setStage = async (stage) => {
    if (job.stage) timings[`${job.stage}Ms`] = Date.now() - stageStarted;
    stageStarted = Date.now();
    job.stage = stage;
    job.lastHeartbeatAt = new Date().toISOString();
    job.stageTimings = { ...timings };
    await persist();
    await callbackHeartbeat(job, stage, timings).catch(() => undefined);
  };
  try {
    await setStage("download");
    console.log("[replay] download started", { matchId: job.matchId, jobId: job.id });
    const download = await downloadReplay(job.replayUrl, downloaded);
    console.log("[replay] download completed", { matchId: job.matchId, compressedBytes: download.size, attempts: download.attempts, resumedBytes: download.resumedBytes });
    const file = await open(downloaded, "r");
    const header = Buffer.alloc(8);
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    const compression = detectReplayCompression(header);
    console.log("[replay] format detected", { matchId: job.matchId, compression });
    await setStage("decompress");
    if (compression === replayCompression.bzip2) {
      await exec("java", ["-cp", "/opt/odota-parser/parser.jar:/opt/odota-parser/replay-tools.jar", "ReplayBzip2", downloaded, replay], { timeout: 120_000 });
    } else if (compression === replayCompression.zstd) {
      await exec("zstd", ["-d", "-f", "-o", replay, downloaded], { timeout: 180_000 });
    } else if (compression === replayCompression.raw) {
      await rename(downloaded, replay);
    } else {
      throw new Error("Valve replay download used an unsupported or invalid format");
    }
    const replaySize = (await stat(replay)).size;
    if (replaySize < 16 || replaySize > 1_000_000_000) throw new Error("decompressed replay size is invalid");

    await setStage("parse");
    console.log("[replay] parser started", { matchId: job.matchId });
    const parsed = await fetch(parserUrl, { method: "POST", body: createReadStream(replay), duplex: "half", signal: AbortSignal.timeout(600_000) });
    if (!parsed.ok || !parsed.body) throw new Error(`parser returned ${parsed.status}`);
    const entries = [];
    const lines = readline.createInterface({ input: Readable.fromWeb(parsed.body), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "interval" || entry.type === "player_slot" || entry.type === "DOTA_COMBATLOG_DEATH" || entry.type === "DOTA_ABILITY_LEVEL" || entry.type === "DOTA_COMBATLOG_PURCHASE" || entry.type === "DOTA_COMBATLOG_DAMAGE" || entry.type === "DOTA_COMBATLOG_HEAL" || entry.type === "DOTA_COMBATLOG_BUYBACK" || entry.type === "DOTA_COMBATLOG_TEAM_BUILDING_KILL" || ["obs", "sen", "obs_left", "sen_left"].includes(entry.type) || String(entry.type).startsWith("CHAT_MESSAGE_")) entries.push(entry);
    }
    await setStage("normalize");
    const result = { schemaVersion: resultSchemaVersion, matchId: job.matchId, generatedAt: new Date().toISOString(), parser: "odota/parser@a03b9e5", ...extractReplayData(entries) };
    timings.normalizeMs = Date.now() - stageStarted;
    job.stageTimings = { ...timings };
    console.log("[replay] parser completed", { matchId: job.matchId, entries: entries.length, resultBytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callback(job, result) {
  if (!callbackBaseUrl || !callbackToken) throw new Error("callback configuration is missing");
  job.stage = "persist";
  job.lastHeartbeatAt = new Date().toISOString();
  await callbackHeartbeat(job, "persist", job.stageTimings ?? {}).catch(() => undefined);
  const response = await fetch(`${callbackBaseUrl}/api/replay-enhancements/${job.matchId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${callbackToken}`, "Content-Type": "application/json", ...(sitesBypassToken ? { "OAI-Sites-Authorization": `Bearer ${sitesBypassToken}` } : {}) },
    body: JSON.stringify({ jobId: job.id, result }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`callback returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  console.log("[replay] callback completed", { matchId: job.matchId, jobId: job.id });
}

async function callbackHeartbeat(job, stage, timings = {}) {
  if (!callbackBaseUrl || !callbackToken) return;
  const response = await fetch(`${callbackBaseUrl}/api/replay-enhancements/${job.matchId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${callbackToken}`, "Content-Type": "application/json", ...(sitesBypassToken ? { "OAI-Sites-Authorization": `Bearer ${sitesBypassToken}` } : {}) },
    body: JSON.stringify({ jobId: job.id, heartbeat: true, stage, parserInstance: hostname(), timings }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 409) throw new Error(`heartbeat callback returned ${response.status}`);
}

async function callbackFailure(job, error) {
  if (!callbackBaseUrl || !callbackToken) return;
  const response = await fetch(`${callbackBaseUrl}/api/replay-enhancements/${job.matchId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${callbackToken}`, "Content-Type": "application/json", ...(sitesBypassToken ? { "OAI-Sites-Authorization": `Bearer ${sitesBypassToken}` } : {}) },
    body: JSON.stringify({ jobId: job.id, error: String(error).slice(0, 500) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`failure callback returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = [...jobs.values()].find((candidate) => candidate.status === "queued");
      if (!job) break;
      Object.assign(job, { status: "running", stage: "acquire", startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), error: null });
      await persist();
      try {
        const result = await parseReplay(job);
        await callback(job, result);
        Object.assign(job, { status: "completed", stage: "completed", completedAt: new Date().toISOString(), killCount: result.kills.length, resultSchemaVersion: result.schemaVersion });
        console.log("[replay] job completed", { matchId: job.matchId, jobId: job.id, killCount: result.kills.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error("[replay] job failed", { matchId: job.matchId, jobId: job.id, error: message, stack: error instanceof Error ? error.stack : null });
        try { await callbackFailure(job, message); } catch (callbackError) { console.error("[replay] failure callback failed", { matchId: job.matchId, error: String(callbackError) }); }
        Object.assign(job, { status: "failed", stage: "failed", completedAt: new Date().toISOString(), error: message });
      }
      await persist();
    }
  } finally { running = false; }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, queued: [...jobs.values()].filter((job) => job.status === "queued").length, running });
  if (!token || req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && url.pathname.startsWith("/v1/jobs/")) {
    const job = jobs.get(url.pathname.split("/").pop());
    return job ? json(res, 200, { job }) : json(res, 404, { error: "job_not_found" });
  }
  if (req.method === "POST" && url.pathname === "/v1/jobs") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20_000) return json(res, 413, { error: "payload_too_large" });
    }
    try {
      const input = JSON.parse(body);
      if (!/^\d{1,20}$/.test(String(input.matchId)) || !validReplayUrl(input.replayUrl, String(input.matchId))) return json(res, 400, { error: "invalid_job" });
      const existing = [...jobs.values()].find((job) => job.matchId === String(input.matchId) && (["queued", "running"].includes(job.status) || (job.status === "completed" && job.resultSchemaVersion === resultSchemaVersion)));
      if (existing) return json(res, 200, { job: existing });
      const requestedJobId = typeof input.jobId === "string" && /^[a-z0-9-]{16,96}$/i.test(input.jobId) ? input.jobId : randomUUID();
      const job = { id: requestedJobId, matchId: String(input.matchId), replayUrl: input.replayUrl, status: "queued", stage: "queued", createdAt: new Date().toISOString(), startedAt: null, completedAt: null, lastHeartbeatAt: null, error: null };
      jobs.set(job.id, job);
      await persist();
      void drain();
      return json(res, 202, { job });
    } catch { return json(res, 400, { error: "invalid_json" }); }
  }
  return json(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", () => { console.log(`replay service listening on ${port}`); void drain(); });
