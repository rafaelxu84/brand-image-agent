#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const host = process.env.BATCH_GUI_HOST || "127.0.0.1";
const port = Number(process.env.BATCH_GUI_PORT || 4180);
const execFileAsync = promisify(execFile);

let currentJob = null;
const logs = [];

function addLog(line) {
  const text = String(line).trimEnd();
  if (!text) return;
  logs.push(`[${new Date().toLocaleTimeString()}] ${text}`);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request body too large.");
  }
  return JSON.parse(body || "{}");
}

function argList(config) {
  const isOpenAIBatch = config.mode === "batch-api";
  const isLogoOnly = config.mode === "logo-only";
  if (isLogoOnly) {
    const args = [
      path.join(rootDir, "scripts/local-logo-batch.mjs"),
      "--input",
      config.input,
      "--output",
      config.output,
      "--logo",
      config.logo,
      "--x",
      String(config.logoX ?? 40),
      "--y",
      String(config.logoY ?? 430),
      "--width",
      String(config.logoWidth ?? 160),
      "--opacity",
      String((Number(config.logoOpacity) || 100) / 100)
    ];
    if (config.force) args.push("--force");
    if (config.dryRun) args.push("--dry-run");
    return args;
  }
  const args = [
    path.join(rootDir, isOpenAIBatch ? "scripts/local-batch-api-worker.mjs" : "scripts/local-batch-worker.mjs"),
    "--input",
    config.input,
    "--output",
    config.output,
    "--quality",
    config.quality || "medium",
  ];
  if (isOpenAIBatch) {
    args.push("--chunk-size", String(config.chunkSize || 100), "--poll-ms", String(config.pollMs || 60000));
    if (config.noWait) args.push("--no-wait");
  } else {
    args.push("--concurrency", String(config.concurrency || 1), "--delay-ms", String(config.delayMs || 1500));
  }
  if (config.retryFailed) args.push("--retry-failed");
  if (config.force) args.push("--force");
  if (config.dryRun) args.push("--dry-run");
  if (config.brand) args.push("--brand", config.brand);
  if (config.instructions) args.push("--instructions", config.instructions);
  return args;
}

async function readManifestSummary(outputDir) {
  if (!outputDir) return null;
  const logoManifestPath = path.join(outputDir, "_logo_manifest.json");
  if (await fileExists(logoManifestPath)) {
    try {
      const manifest = JSON.parse(await fs.readFile(logoManifestPath, "utf8"));
      const records = Object.values(manifest.files || {});
      return {
        total: records.length,
        completed: records.filter((item) => item.status === "completed").length,
        failed: records.filter((item) => item.status === "failed").length,
        running: records.filter((item) => item.status === "running").length,
        updatedAt: manifest.updatedAt || manifest.createdAt || null,
        failedItems: Object.entries(manifest.files || {})
          .filter(([, item]) => item.status === "failed")
          .slice(0, 50)
          .map(([name, item]) => ({ name, error: item.error || "" }))
      };
    } catch {
      return null;
    }
  }

  const batchManifestPath = path.join(outputDir, "_batch_manifest.json");
  if (await fileExists(batchManifestPath)) {
    try {
      const manifest = JSON.parse(await fs.readFile(batchManifestPath, "utf8"));
      const records = Object.values(manifest.files || {});
      return {
        total: records.length,
        completed: records.filter((item) => item.status === "completed").length,
        failed: records.filter((item) => item.status === "failed" || item.status === "expired" || item.status === "cancelled").length,
        running: records.filter((item) => item.status === "running" || item.status === "submitted" || item.status === "preparing").length,
        updatedAt: manifest.updatedAt || manifest.createdAt || null,
        failedItems: Object.entries(manifest.files || {})
          .filter(([, item]) => item.status === "failed" || item.status === "expired" || item.status === "cancelled")
          .slice(0, 50)
          .map(([name, item]) => ({ name, error: item.error || "" }))
      };
    } catch {
      return null;
    }
  }

  const manifestPath = path.join(outputDir, "_manifest.json");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const records = Object.values(manifest.files || {});
    return {
      total: records.length,
      completed: records.filter((item) => item.status === "completed").length,
      failed: records.filter((item) => item.status === "failed").length,
      running: records.filter((item) => item.status === "running").length,
      updatedAt: manifest.updatedAt || manifest.createdAt || null,
      failedItems: Object.entries(manifest.files || {})
        .filter(([, item]) => item.status === "failed")
        .slice(0, 50)
        .map(([name, item]) => ({ name, error: item.error || "" }))
    };
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function startJob(config) {
  if (currentJob?.running) throw new Error("A batch is already running.");
  if (!config.input || !config.output) {
    throw new Error("Input folder and output folder are required.");
  }
  if (config.mode === "logo-only" && !config.logo) {
    throw new Error("Logo file is required for Logo-only batch mode.");
  }

  logs.length = 0;
  addLog(
    config.mode === "batch-api"
      ? "Starting OpenAI Batch API worker..."
      : config.mode === "logo-only"
        ? "Starting local logo batch worker..."
        : "Starting local live worker..."
  );
  const env = { ...process.env };
  if (config.apiKey) env.OPENAI_API_KEY = config.apiKey;
  const child = spawn(process.execPath, argList(config), {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  currentJob = {
    running: true,
    pid: child.pid,
    config: { ...config, apiKey: config.apiKey ? "provided" : "" },
    startedAt: new Date().toISOString(),
    exitCode: null
  };

  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) addLog(line);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) addLog(line);
  });
  child.on("exit", (code, signal) => {
    currentJob.running = false;
    currentJob.exitCode = code;
    currentJob.signal = signal;
    currentJob.finishedAt = new Date().toISOString();
    addLog(`Worker finished with code=${code} signal=${signal || "none"}.`);
  });
}

function stopJob() {
  if (!currentJob?.running || !currentJob.pid) return false;
  try {
    process.kill(currentJob.pid, "SIGTERM");
    addLog("Stop requested. Waiting for worker to exit...");
    return true;
  } catch (error) {
    addLog(`Stop failed: ${error.message}`);
    return false;
  }
}

async function pickPath(kind) {
  if (process.platform !== "darwin") {
    throw new Error("Native path picker is currently supported on macOS. Paste the path manually on this OS.");
  }

  const scripts = {
    input: 'POSIX path of (choose folder with prompt "Choose the source image folder")',
    output: 'POSIX path of (choose folder with prompt "Choose the output folder")',
    logo: 'POSIX path of (choose file with prompt "Choose the transparent logo file")',
  };
  if (!scripts[kind]) throw new Error("Unknown picker type.");

  let stdout = "";
  try {
    const result = await execFileAsync("osascript", ["-e", scripts[kind]], { timeout: 120000 });
    stdout = result.stdout;
  } catch (error) {
    if (String(error.stderr || error.message).includes("User canceled")) {
      return "";
    }
    throw error;
  }
  const selectedPath = stdout.trim();
  if (!selectedPath) throw new Error("No path selected.");
  return selectedPath;
}

const html = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Local Batch Console</title>
    <style>
      :root { color-scheme: dark; --bg:#10130f; --panel:#181d17; --line:#384234; --text:#f4f5ed; --muted:#aeb7a6; --accent:#d5f05c; --danger:#ff8a65; }
      * { box-sizing:border-box; }
      body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width:min(1280px,100%); margin:0 auto; padding:20px; display:grid; grid-template-columns:380px minmax(0,1fr); gap:18px; }
      section, aside { border:1px solid var(--line); background:var(--panel); padding:18px; }
      h1 { margin:0 0 16px; font-size:26px; }
      label { display:grid; gap:7px; margin-bottom:12px; color:var(--muted); font-size:13px; font-weight:700; }
      input, select, textarea, button { font:inherit; }
      input, select, textarea { width:100%; border:1px solid var(--line); border-radius:8px; background:#10150f; color:var(--text); padding:10px 11px; }
      textarea { resize:vertical; }
      button { min-height:42px; border:1px solid transparent; border-radius:8px; padding:0 14px; background:var(--accent); color:#171a12; font-weight:800; cursor:pointer; }
      button.secondary { background:transparent; border-color:var(--line); color:var(--text); }
      button.danger { background:transparent; border-color:var(--danger); color:var(--danger); }
      .path-row { display:grid; grid-template-columns:minmax(0,1fr) 92px; gap:8px; }
      .actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .hidden { display:none; }
      .stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-bottom:14px; }
      .stat { border:1px solid var(--line); padding:12px; background:#111710; }
      .stat strong { display:block; font-size:24px; }
      .stat span { color:var(--muted); font-size:12px; }
      pre { min-height:420px; max-height:60vh; overflow:auto; margin:0; padding:14px; border:1px solid var(--line); background:#0b0f0a; color:#d8decf; white-space:pre-wrap; }
      .hint { color:var(--muted); font-size:13px; line-height:1.45; }
      @media (max-width:900px){ main { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <main>
      <aside>
        <h1>Local Batch Console</h1>
        <label>Processing mode
          <select id="mode">
            <option value="batch-api" selected>OpenAI Batch API - lowest cost</option>
            <option value="live">Live local requests - immediate</option>
            <option value="logo-only">Logo-only batch - no AI</option>
          </select>
        </label>
        <label>Source image folder <span class="path-row"><input id="input" placeholder="/Users/rafa/Downloads/source-images" /><button id="pickInput" class="secondary" type="button">Browse</button></span></label>
        <label>Output folder <span class="path-row"><input id="output" placeholder="/Users/rafa/Downloads/cover-output" /><button id="pickOutput" class="secondary" type="button">Browse</button></span></label>
        <label class="ai-row">OpenAI API key <input id="apiKey" type="password" placeholder="Optional if exported in terminal" /></label>
        <label class="ai-row">Brand name <input id="brand" placeholder="Pragmatic Play" /></label>
        <label class="ai-row">Quality
          <select id="quality">
            <option value="low">Low - draft</option>
            <option value="medium" selected>Medium - balanced</option>
            <option value="high">High - final</option>
          </select>
        </label>
        <label class="logo-row">Logo file <span class="path-row"><input id="logo" placeholder="/Users/rafa/Downloads/logo.png" /><button id="pickLogo" class="secondary" type="button">Browse</button></span></label>
        <label class="logo-row">Logo X <input id="logoX" type="number" value="40" /></label>
        <label class="logo-row">Logo Y <input id="logoY" type="number" value="430" /></label>
        <label class="logo-row">Logo width <input id="logoWidth" type="number" min="1" value="160" /></label>
        <label class="logo-row">Logo opacity % <input id="logoOpacity" type="number" min="0" max="100" value="100" /></label>
        <label class="live-row">Concurrency <input id="concurrency" type="number" min="1" max="4" value="1" /></label>
        <label class="live-row">Delay ms <input id="delayMs" type="number" min="0" value="1500" /></label>
        <label class="batch-row">Batch chunk size <input id="chunkSize" type="number" min="1" max="500" value="100" /></label>
        <label class="batch-row">Poll seconds <input id="pollSeconds" type="number" min="10" value="60" /></label>
        <label class="ai-row">Extra instructions <textarea id="instructions" rows="4"></textarea></label>
        <label><span><input id="retryFailed" type="checkbox" /> Retry failed only</span></label>
        <label><span><input id="force" type="checkbox" /> Regenerate all</span></label>
        <label class="batch-row"><span><input id="noWait" type="checkbox" /> Submit only, collect later</span></label>
        <label><span><input id="dryRun" type="checkbox" /> Dry run</span></label>
        <div class="actions">
          <button id="start">Start</button>
          <button id="stop" class="danger">Stop</button>
        </div>
        <p class="hint">Tip: use OpenAI Batch API for 600+ images. After AI output is ready, switch to Logo-only batch, choose that output folder as the source, choose a new output folder, and press Start.</p>
      </aside>
      <section>
        <div class="stats">
          <div class="stat"><strong id="completed">0</strong><span>Completed</span></div>
          <div class="stat"><strong id="failed">0</strong><span>Failed</span></div>
          <div class="stat"><strong id="running">0</strong><span>Running</span></div>
          <div class="stat"><strong id="total">0</strong><span>Total seen</span></div>
        </div>
        <p id="state" class="hint">Idle.</p>
        <pre id="logs"></pre>
      </section>
    </main>
    <script>
      const ids = ["mode","input","output","apiKey","brand","quality","logo","logoX","logoY","logoWidth","logoOpacity","concurrency","delayMs","chunkSize","pollSeconds","instructions","retryFailed","force","noWait","dryRun"];
      const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
      const logs = document.getElementById("logs");
      const state = document.getElementById("state");
      const statIds = ["completed","failed","running","total"];
      const stats = Object.fromEntries(statIds.map(id => [id, document.getElementById(id)]));
      for (const id of ids) {
        const saved = localStorage.getItem("batch." + id);
        if (saved !== null) {
          if (el[id].type === "checkbox") el[id].checked = saved === "true";
          else el[id].value = saved;
        }
        el[id].addEventListener("input", () => localStorage.setItem("batch." + id, el[id].type === "checkbox" ? el[id].checked : el[id].value));
      }
      function syncModeFields() {
        const isBatch = el.mode.value === "batch-api";
        const isLogoOnly = el.mode.value === "logo-only";
        for (const node of document.querySelectorAll(".batch-row")) node.classList.toggle("hidden", !isBatch);
        for (const node of document.querySelectorAll(".live-row")) node.classList.toggle("hidden", isBatch || isLogoOnly);
        for (const node of document.querySelectorAll(".ai-row")) node.classList.toggle("hidden", isLogoOnly);
        for (const node of document.querySelectorAll(".logo-row")) node.classList.toggle("hidden", !isLogoOnly);
      }
      el.mode.addEventListener("change", () => {
        localStorage.setItem("batch.mode", el.mode.value);
        syncModeFields();
      });
      syncModeFields();
      function payload() {
        return {
          mode: el.mode.value,
          input: el.input.value.trim(),
          output: el.output.value.trim(),
          logo: el.logo.value.trim(),
          apiKey: el.apiKey.value.trim(),
          brand: el.brand.value.trim(),
          quality: el.quality.value,
          logoX: Number(el.logoX.value || 40),
          logoY: Number(el.logoY.value || 430),
          logoWidth: Number(el.logoWidth.value || 160),
          logoOpacity: Number(el.logoOpacity.value || 100),
          concurrency: Number(el.concurrency.value || 1),
          delayMs: Number(el.delayMs.value || 1500),
          chunkSize: Number(el.chunkSize.value || 100),
          pollMs: Number(el.pollSeconds.value || 60) * 1000,
          instructions: el.instructions.value.trim(),
          retryFailed: el.retryFailed.checked,
          force: el.force.checked,
          noWait: el.noWait.checked,
          dryRun: el.dryRun.checked
        };
      }
      async function post(url, body = {}) {
        const res = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Request failed");
        return data;
      }
      async function pick(kind, targetId) {
        try {
          const data = await post("/api/pick", { kind });
          if (!data.path) return;
          el[targetId].value = data.path;
          localStorage.setItem("batch." + targetId, data.path);
        } catch (error) {
          alert(error.message);
        }
      }
      document.getElementById("pickInput").onclick = () => pick("input", "input");
      document.getElementById("pickOutput").onclick = () => pick("output", "output");
      document.getElementById("pickLogo").onclick = () => pick("logo", "logo");
      document.getElementById("start").onclick = async () => {
        try { await post("/api/start", payload()); await refresh(); }
        catch (error) { alert(error.message); }
      };
      document.getElementById("stop").onclick = async () => {
        try { await post("/api/stop"); await refresh(); }
        catch (error) { alert(error.message); }
      };
      async function refresh() {
        const res = await fetch("/api/status");
        const data = await res.json();
        state.textContent = data.job?.running ? "Running pid " + data.job.pid : (data.job ? "Stopped. Exit code " + data.job.exitCode : "Idle.");
        logs.textContent = (data.logs || []).join("\\n");
        logs.scrollTop = logs.scrollHeight;
        const summary = data.summary || {};
        stats.completed.textContent = summary.completed || 0;
        stats.failed.textContent = summary.failed || 0;
        stats.running.textContent = summary.running || 0;
        stats.total.textContent = summary.total || 0;
      }
      setInterval(refresh, 2000);
      refresh();
    </script>
  </body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const summary = await readManifestSummary(currentJob?.config?.output);
      sendJson(res, 200, { job: currentJob, logs, summary });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/start") {
      startJob(await readJson(req));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      sendJson(res, 200, { ok: stopJob() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/pick") {
      const { kind } = await readJson(req);
      sendJson(res, 200, { path: await pickPath(kind) });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Request failed" });
  }
});

server.listen(port, host, () => {
  console.log(`Local batch GUI: http://${host}:${port}`);
});
