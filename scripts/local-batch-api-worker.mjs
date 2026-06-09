#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const DESIGN = {
  width: 400,
  height: 533,
  footerHeight: 116,
  titleMaxWidth: 360,
  titleCenterY: Math.round(533 * 0.618)
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TERMINAL_BATCH_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);
const GUIDE_VERSION = "no-logo-golden-title-v2";

function parseArgs(argv) {
  const args = {
    input: "",
    logo: "",
    output: "batch-output",
    quality: "medium",
    chunkSize: 100,
    pollMs: 60000,
    force: false,
    retryFailed: false,
    dryRun: false,
    noWait: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--retry-failed") {
      args.retryFailed = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--no-wait") {
      args.noWait = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      if (key === "chunk-size") args.chunkSize = Number(value);
      else if (key === "poll-ms") args.pollMs = Number(value);
      else args[key] = value;
    }
  }

  return args;
}

function usage() {
  return `
Local OpenAI Batch API cover worker

Usage:
  OPENAI_API_KEY=sk-... npm run batch:api -- \\
    --input /path/to/source-images \\
    --output /path/to/output-folder \\
    --quality medium

Options:
  --quality low|medium|high    Default: medium
  --chunk-size 100             Requests per OpenAI batch job
  --poll-ms 60000              Status polling interval while waiting
  --force                      Regenerate completed files too
  --retry-failed               Resubmit files previously marked failed
  --no-wait                    Submit batches and exit without waiting
  --dry-run                    List work without calling OpenAI
`.trim();
}

function normalizeQuality(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, { label = "request", attempts = 6 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 408 && response.status !== 409 && response.status !== 429 && response.status < 500) {
        return response;
      }
      lastError = new Error(`${label} returned ${response.status}`);
      if (attempt === attempts) return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    const waitMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
    console.log(`${label} failed (${lastError.message}); retrying in ${Math.round(waitMs / 1000)}s...`);
    await sleep(waitMs);
  }
  throw lastError || new Error(`${label} failed`);
}

function safeBaseName(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "cover";
}

function batchKey() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function customIdFor(index, filePath) {
  return `cover-${String(index + 1).padStart(5, "0")}-${safeBaseName(filePath).slice(0, 42)}`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listImages(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function imageBuffer(filePath, { maxSide = 1280, format = "jpeg", quality = 84 } = {}) {
  const pipeline = sharp(filePath).rotate();
  const metadata = await pipeline.metadata();
  const scale = Math.min(1, maxSide / Math.max(metadata.width || maxSide, metadata.height || maxSide));
  const width = Math.max(1, Math.round((metadata.width || maxSide) * scale));
  const height = Math.max(1, Math.round((metadata.height || maxSide) * scale));
  return sharp(filePath)
    .rotate()
    .resize(width, height, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#111111" })
    .toFormat(format, { quality })
    .toBuffer();
}

function gradientSvg() {
  return Buffer.from(`
<svg width="${DESIGN.width}" height="${DESIGN.height}" viewBox="0 0 ${DESIGN.width} ${DESIGN.height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="330" x2="0" y2="${DESIGN.height}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#090909" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#12100b" stop-opacity="0.72"/>
      <stop offset="1" stop-color="#04070c" stop-opacity="0.96"/>
    </linearGradient>
    <radialGradient id="vignette" cx="200" cy="250" r="310" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.30"/>
    </radialGradient>
  </defs>
  <rect x="0" y="330" width="${DESIGN.width}" height="203" fill="url(#fade)"/>
  <rect x="0" y="0" width="${DESIGN.width}" height="${DESIGN.height}" fill="url(#vignette)"/>
</svg>`);
}

async function makeGuideBuffer(sourcePath) {
  const sourceMeta = await sharp(sourcePath).rotate().metadata();
  const sourceWidth = sourceMeta.width || DESIGN.width;
  const sourceHeight = sourceMeta.height || DESIGN.height;
  const background = await sharp(sourcePath)
    .rotate()
    .resize(DESIGN.width + 40, DESIGN.height + 40, { fit: "cover" })
    .blur(8)
    .modulate({ saturation: 1.08 })
    .extract({ left: 20, top: 20, width: DESIGN.width, height: DESIGN.height })
    .toBuffer();

  const artHeight = DESIGN.titleCenterY + 118;
  const artScale = Math.min(DESIGN.width / sourceWidth, artHeight / sourceHeight);
  const artWidth = Math.max(1, Math.round(sourceWidth * artScale));
  const artDrawHeight = Math.max(1, Math.round(sourceHeight * artScale));
  const artLeft = Math.round((DESIGN.width - artWidth) / 2);
  const artTopOffset = Math.round((artHeight - artDrawHeight) * 0.56);
  const artwork = await sharp(sourcePath)
    .rotate()
    .resize(artWidth, artDrawHeight, { fit: "fill" })
    .toBuffer();

  return sharp(background)
    .composite([
      { input: artwork, left: artLeft, top: artTopOffset },
      { input: gradientSvg(), left: 0, top: 0 }
    ])
    .jpeg({ quality: 82 })
    .toBuffer();
}

async function resizeFinalImage(base64) {
  const input = Buffer.from(base64, "base64");
  return sharp(input)
    .resize(DESIGN.width, DESIGN.height, { fit: "fill" })
    .png()
    .toBuffer();
}

function buildPrompt({ brandName, instructions }) {
  return [
    "Create a premium static game-catalog portrait cover image from the first reference image.",
    brandName ? `Brand name: ${brandName}.` : "Brand name is unknown.",
    "This is a static artwork resizing and composition task for a cover thumbnail. Do not create a gambling interface, betting slip, odds board, payout promise, real-money promotion, call-to-action button, or new jackpot/winnings claim.",
    "Use the second reference image as the exact composition guide.",
    "Do not add any brand logo, provider logo, watermark, badge, UI label, footer plaque, or lower-left brand mark.",
    "Exact output layout standard: final visual is a 400px wide by 533px high canvas. The game title block must be centered and scaled to nearly fill the 360px safe width. If the title is smaller than 340px wide, enlarge it; if wider than 360px, shrink it. Target title width is 350-360px with crisp readable lettering.",
    "Golden composition rule: place the visual center of the game title block around y=329px on the 400x533 canvas. Acceptable title-center range is y=305-345px. Keep the title centered horizontally, large, exposed, and readable.",
    "Do not crop, trim, zoom into, or cut off important original source information. Keep full game title, top multipliers, upper decorations, corner subjects, side subjects, main subject, and readable text visible. If space is tight, zoom out and extend/rebuild surrounding background.",
    "Create a cinematic lower dark/smoky/soft-gradient obstruction in the lower 14-22% that covers busy background detail but does not hide the game title.",
    "Preserve original title text as accurately as possible. Do not invent new words, buttons, UI, jackpot badges, watermarks, or borders.",
    "Make the result sharp, premium, balanced, readable, and commercially polished.",
    instructions ? `Additional direction: ${instructions}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRequestBody({ model, quality, brandName, instructions, sourceFileId, guideFileId }) {
  return {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: buildPrompt({ brandName, instructions }) },
          { type: "input_image", file_id: sourceFileId },
          { type: "input_image", file_id: guideFileId }
        ]
      }
    ],
    tools: [
      {
        type: "image_generation",
        size: "1024x1536",
        quality,
        action: "edit"
      }
    ],
    tool_choice: { type: "image_generation" }
  };
}

async function openaiJson(apiKey, pathname, { method = "GET", body } = {}) {
  const response = await fetchWithRetry(`https://api.openai.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }, { label: `OpenAI ${method} ${pathname}` });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI ${method} ${pathname} failed with ${response.status}`);
  return data;
}

async function uploadFile(apiKey, { buffer, filename, purpose, contentType }) {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([buffer], { type: contentType }), filename);
  const response = await fetchWithRetry("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  }, { label: `OpenAI upload ${filename}` });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI file upload failed with ${response.status}`);
  return data;
}

async function downloadFileText(apiKey, fileId) {
  const response = await fetchWithRetry(`https://api.openai.com/v1/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  }, { label: `OpenAI download ${fileId}` });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `OpenAI file download failed with ${response.status}`);
  return text;
}

async function readManifest(manifestPath) {
  if (!(await pathExists(manifestPath))) {
    return { mode: "openai_batch", guideVersion: GUIDE_VERSION, createdAt: new Date().toISOString(), files: {}, batches: {}, customIds: {} };
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.guideVersion ||= "";
  manifest.files ||= {};
  manifest.batches ||= {};
  manifest.customIds ||= {};
  return manifest;
}

async function writeManifest(manifestPath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function outputPathFor(args, filePath) {
  return path.join(args.output, `${safeBaseName(filePath)}-ai-portrait.png`);
}

function shouldIncludeFile(record, outputPath, retryFailed, force) {
  if (force) return true;
  if (retryFailed) return ["failed", "expired", "cancelled"].includes(record?.status);
  if (!record) return true;
  if (record.status === "completed") return false;
  if (record.status === "failed") return retryFailed;
  if (record.status === "expired" || record.status === "cancelled") return retryFailed;
  if (record.status === "submitted" || record.status === "running") return false;
  return true;
}

async function ensureVisionAssets({ apiKey, args, manifest, manifestPath, files }) {
  manifest.guideVersion = GUIDE_VERSION;
  for (const [index, filePath] of files.entries()) {
    const key = path.basename(filePath);
    const outputPath = outputPathFor(args, filePath);
    const existing = manifest.files[key];
    if (!shouldIncludeFile(existing, outputPath, args.retryFailed, args.force)) continue;

    const customId = existing?.customId || customIdFor(index, filePath);
    manifest.files[key] = {
      ...existing,
      status: "preparing",
      source: filePath,
      output: outputPath,
      customId,
      preparedAt: new Date().toISOString()
    };
    manifest.customIds[customId] = key;
    await writeManifest(manifestPath, manifest);

    if (!manifest.files[key].sourceFileId) {
      console.log(`upload source: ${key}`);
      const sourceBuffer = await imageBuffer(filePath, { maxSide: 1280, format: "jpeg", quality: 84 });
      const uploaded = await uploadFile(apiKey, {
        buffer: sourceBuffer,
        filename: `${safeBaseName(filePath)}-source.jpg`,
        purpose: "vision",
        contentType: "image/jpeg"
      });
      manifest.files[key].sourceFileId = uploaded.id;
      await writeManifest(manifestPath, manifest);
    }

    if (args.force || manifest.files[key].guideVersion !== GUIDE_VERSION || !manifest.files[key].guideFileId) {
      console.log(`upload guide: ${key}`);
      const guideBuffer = await makeGuideBuffer(filePath);
      const uploaded = await uploadFile(apiKey, {
        buffer: guideBuffer,
        filename: `${safeBaseName(filePath)}-guide.jpg`,
        purpose: "vision",
        contentType: "image/jpeg"
      });
      manifest.files[key].guideFileId = uploaded.id;
      manifest.files[key].guideVersion = GUIDE_VERSION;
      await writeManifest(manifestPath, manifest);
    }
  }
}

function pendingPreparedRecords(manifest, args) {
  return Object.entries(manifest.files)
    .filter(([, item]) => {
      if (item.status !== "preparing") return false;
      if (!item.sourceFileId || !item.guideFileId || !item.customId) return false;
      if (args.retryFailed) return true;
      return true;
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

async function submitBatches({ apiKey, args, manifest, manifestPath, model }) {
  const prepared = pendingPreparedRecords(manifest, args);
  if (!prepared.length) {
    console.log("no new prepared files to submit");
    return;
  }

  const batchDir = path.join(args.output, "_batch_requests");
  await fs.mkdir(batchDir, { recursive: true });
  for (let i = 0; i < prepared.length; i += args.chunkSize) {
    const chunk = prepared.slice(i, i + args.chunkSize);
    const key = batchKey();
    const jsonlPath = path.join(batchDir, `batch-${key}-${String(i / args.chunkSize + 1).padStart(3, "0")}.jsonl`);
    const lines = chunk.map(([, item]) =>
      JSON.stringify({
        custom_id: item.customId,
        method: "POST",
        url: "/v1/responses",
        body: buildRequestBody({
          model,
          quality: args.quality,
          brandName: args.brand || "",
          instructions: args.instructions || "",
          sourceFileId: item.sourceFileId,
          guideFileId: item.guideFileId
        })
      })
    );
    await fs.writeFile(jsonlPath, `${lines.join("\n")}\n`);
    console.log(`upload batch input: ${path.basename(jsonlPath)} (${chunk.length} requests)`);
    const inputFile = await uploadFile(apiKey, {
      buffer: await fs.readFile(jsonlPath),
      filename: path.basename(jsonlPath),
      purpose: "batch",
      contentType: "application/jsonl"
    });
    const batch = await openaiJson(apiKey, "/batches", {
      method: "POST",
      body: {
        input_file_id: inputFile.id,
        endpoint: "/v1/responses",
        completion_window: "24h"
      }
    });

    manifest.batches[batch.id] = {
      status: batch.status,
      inputFileId: inputFile.id,
      outputFileId: batch.output_file_id || null,
      errorFileId: batch.error_file_id || null,
      requestCount: chunk.length,
      jsonlPath,
      submittedAt: new Date().toISOString()
    };
    for (const [name, item] of chunk) {
      manifest.files[name].status = "submitted";
      manifest.files[name].batchId = batch.id;
      manifest.files[name].submittedAt = new Date().toISOString();
      manifest.customIds[item.customId] = name;
    }
    await writeManifest(manifestPath, manifest);
    console.log(`submitted batch: ${batch.id}`);
  }
}

async function collectBatchOutput({ apiKey, args, manifest, manifestPath, batchId, batch }) {
  if (!batch.outputFileId || batch.outputDownloadedAt) return;
  console.log(`download results: ${batchId}`);
  const text = await downloadFileText(apiKey, batch.outputFileId);
  const outputDir = path.join(args.output, "_batch_results");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, `${batchId}.jsonl`), text);

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const result = JSON.parse(line);
    const fileKey = manifest.customIds[result.custom_id];
    if (!fileKey || !manifest.files[fileKey]) continue;
    const record = manifest.files[fileKey];

    if (result.error) {
      record.status = "failed";
      record.error = result.error.message || JSON.stringify(result.error);
      record.failedAt = new Date().toISOString();
      continue;
    }

    if (result.response?.status_code < 200 || result.response?.status_code >= 300) {
      record.status = "failed";
      record.error = result.response?.body?.error?.message || `Batch response status ${result.response?.status_code}`;
      record.failedAt = new Date().toISOString();
      continue;
    }

    const body = result.response?.body;
    const imageCall = body?.output?.find((item) => item.type === "image_generation_call");
    if (!imageCall?.result) {
      record.status = "failed";
      record.error = "OpenAI did not return an image result.";
      record.failedAt = new Date().toISOString();
      continue;
    }

    const finalBuffer = await resizeFinalImage(imageCall.result);
    await fs.writeFile(record.output, finalBuffer);
    record.status = "completed";
    record.completedAt = new Date().toISOString();
    delete record.error;
    console.log(`saved: ${path.basename(record.output)}`);
  }

  batch.outputDownloadedAt = new Date().toISOString();
  await writeManifest(manifestPath, manifest);
}

async function updateBatches({ apiKey, args, manifest, manifestPath }) {
  let active = 0;
  for (const [batchId, batchRecord] of Object.entries(manifest.batches)) {
    if (batchRecord.outputDownloadedAt || ["failed", "expired", "cancelled"].includes(batchRecord.status)) continue;
    const batch = await openaiJson(apiKey, `/batches/${batchId}`);
    batchRecord.status = batch.status;
    batchRecord.outputFileId = batch.output_file_id || batchRecord.outputFileId || null;
    batchRecord.errorFileId = batch.error_file_id || batchRecord.errorFileId || null;
    batchRecord.requestCounts = batch.request_counts || batchRecord.requestCounts || null;
    batchRecord.checkedAt = new Date().toISOString();
    console.log(`batch ${batchId}: ${batch.status}`);

    if (!TERMINAL_BATCH_STATUSES.has(batch.status)) {
      active += 1;
      for (const item of Object.values(manifest.files)) {
        if (item.batchId === batchId && item.status === "submitted") item.status = "running";
      }
      await writeManifest(manifestPath, manifest);
      continue;
    }

    if (batch.status === "completed") {
      await collectBatchOutput({ apiKey, args, manifest, manifestPath, batchId, batch: batchRecord });
    } else {
      for (const item of Object.values(manifest.files)) {
        if (item.batchId === batchId && !["completed", "failed"].includes(item.status)) {
          item.status = batch.status;
          item.error = `Batch ${batch.status}`;
          item.failedAt = new Date().toISOString();
        }
      }
      await writeManifest(manifestPath, manifest);
    }
  }
  return active;
}

function printSummary(manifest) {
  const records = Object.values(manifest.files);
  const count = (status) => records.filter((item) => item.status === status).length;
  console.log(
    `summary: completed=${count("completed")}, failed=${count("failed")}, preparing=${count("preparing")}, submitted=${count("submitted")}, running=${count("running")}, total=${records.length}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.input) {
    console.log(usage());
    process.exit(1);
  }

  args.quality = normalizeQuality(args.quality);
  args.chunkSize = Math.max(1, Math.min(500, Number(args.chunkSize) || 100));
  args.pollMs = Math.max(10000, Number(args.pollMs) || 60000);
  args.input = path.resolve(args.input);
  if (args.logo) args.logo = path.resolve(args.logo);
  args.output = path.resolve(args.output);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !args.dryRun) throw new Error("OPENAI_API_KEY is required.");
  const model = process.env.OPENAI_TEXT_MODEL || "gpt-5.2";

  await fs.mkdir(args.output, { recursive: true });
  const manifestPath = path.join(args.output, "_batch_manifest.json");
  const manifest = await readManifest(manifestPath);
  const files = await listImages(args.input);
  console.log(`found ${files.length} image(s)`);
  console.log(`output: ${args.output}`);
  console.log(`quality: ${args.quality}, chunk size: ${args.chunkSize}`);

  if (args.dryRun) {
    for (const file of files) console.log(file);
    return;
  }

  await ensureVisionAssets({ apiKey, args, manifest, manifestPath, files });
  await submitBatches({ apiKey, args, manifest, manifestPath, model });
  printSummary(manifest);

  if (args.noWait) {
    console.log("submitted. Run this command again later without --no-wait to collect results.");
    return;
  }

  while (true) {
    const active = await updateBatches({ apiKey, args, manifest, manifestPath });
    printSummary(manifest);
    if (active === 0) break;
    console.log(`waiting ${Math.round(args.pollMs / 1000)}s before next status check...`);
    await sleep(args.pollMs);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
