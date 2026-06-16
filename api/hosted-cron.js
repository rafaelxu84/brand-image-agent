import {
  HOSTED_MAX_COLLECT_BATCHES,
  checkCronSecret,
  cleanupExpiredHostedJobs,
  downloadOpenAIFile,
  json,
  openaiJson,
  readIndex,
  readManifest,
  safeName,
  storeOutputPng,
  writeIndex,
  writeManifest
} from "./hosted-shared.js";

const COLLECT_ERROR_LIMIT = 3;
const TERMINAL_BATCH_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);
const STALE_BATCH_HOURS = Math.max(1, Number(process.env.HOSTED_STALE_BATCH_HOURS) || 8);

function summarize(manifest) {
  const completed = manifest.files.filter((file) => file.status === "completed").length;
  const failed = manifest.files.filter((file) => file.status === "failed").length;
  const running = manifest.files.some((file) => file.status === "submitted" || file.status === "running");
  const active = manifest.batches.some((batch) => !TERMINAL_BATCH_STATUSES.has(batch.status));
  manifest.status = active || running ? "running" : failed ? "completed_with_errors" : "completed";
  return { completed, failed, total: manifest.files.length };
}

function findFileForRow(manifest, batch, row, batchIndex) {
  const mappedItem = (batch.items || []).find((item) => item.customId === row.custom_id);
  if (mappedItem && manifest.files[mappedItem.fileIndex]) return manifest.files[mappedItem.fileIndex];

  const customIndex = Number(String(row.custom_id).split("-").at(-1)) - 1;
  const chunkOffset = manifest.batches.slice(0, batchIndex).reduce((sum, item) => sum + item.requestCount, 0);
  return manifest.files[chunkOffset + customIndex] || null;
}

function batchNeedsCollection(batch) {
  if (batch.collectFinalError) return false;
  if (!batch.completed && !TERMINAL_BATCH_STATUSES.has(batch.status)) return true;
  if (batch.errorFileId && !batch.errorDownloadedAt) return true;
  return false;
}

function errorMessageFromRow(row) {
  return (
    row.error?.message ||
    row.response?.body?.error?.message ||
    row.response?.error?.message ||
    row.message ||
    "OpenAI batch request failed."
  );
}

function batchAgeHours(batch, now = new Date()) {
  const startedAt = new Date(batch.submittedAt || batch.createdAt || batch.checkedAt || now).getTime();
  if (!Number.isFinite(startedAt)) return 0;
  return (now.getTime() - startedAt) / 36e5;
}

function markBatchStale(manifest, batch) {
  const age = batchAgeHours(batch);
  const progress = batch.requestCounts
    ? `${batch.requestCounts.completed || 0}/${batch.requestCounts.total || batch.requestCount || 0}`
    : "unknown progress";
  const message = `OpenAI batch stayed ${batch.status} for ${age.toFixed(1)}h (${progress}); marked stale after ${STALE_BATCH_HOURS}h so it can be retried.`;

  batch.status = "failed";
  batch.completed = true;
  batch.staleAt = new Date().toISOString();
  batch.failedAt ||= batch.staleAt;
  batch.collectFinalError = message;

  for (const item of batch.items || []) {
    const file = manifest.files[item.fileIndex];
    if (!file || file.status === "completed") continue;
    file.status = "failed";
    file.error = message;
    file.failedAt = batch.staleAt;
  }
}

async function collectBatch({ apiKey, manifest, batch }) {
  const remote = await openaiJson(apiKey, `/batches/${batch.id}`);
  batch.status = remote.status;
  batch.outputFileId = remote.output_file_id || batch.outputFileId || null;
  batch.errorFileId = remote.error_file_id || batch.errorFileId || null;
  batch.requestCounts = remote.request_counts || batch.requestCounts || null;
  batch.checkedAt = new Date().toISOString();

  if (remote.status !== "completed") {
    if (TERMINAL_BATCH_STATUSES.has(remote.status)) {
      for (const item of batch.items || []) {
        const file = manifest.files[item.fileIndex];
        if (!file || file.status === "completed") continue;
        file.status = "failed";
        file.error = `Batch ${remote.status}`;
        file.failedAt = new Date().toISOString();
      }
      batch.completed = true;
      batch.failedAt ||= new Date().toISOString();
      return false;
    }

    if (batchAgeHours(batch) >= STALE_BATCH_HOURS) {
      markBatchStale(manifest, batch);
    }

    return false;
  }

  const batchIndex = manifest.batches.findIndex((item) => item.id === batch.id);

  if (batch.outputFileId && !batch.outputDownloadedAt) {
    const outputText = await downloadOpenAIFile(apiKey, batch.outputFileId);
    for (const line of outputText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row = null;
      let file = null;
      try {
        row = JSON.parse(line);
        file = findFileForRow(manifest, batch, row, batchIndex);
        if (!file) continue;

        if (row.error || row.response?.status_code >= 400) {
          file.status = "failed";
          file.error = errorMessageFromRow(row);
          continue;
        }

        const imageCall = row.response?.body?.output?.find((item) => item.type === "image_generation_call");
        if (!imageCall?.result) {
          file.status = "failed";
          file.error = "OpenAI did not return an image result.";
          continue;
        }

        const blob = await storeOutputPng({
          jobId: manifest.id,
          name: safeName(file.name),
          base64: imageCall.result
        });
        file.status = "completed";
        file.outputUrl = blob.url;
        file.error = null;
        file.completedAt = new Date().toISOString();
      } catch (error) {
        if (file) {
          file.status = "failed";
          file.error = `Collector failed while saving output: ${error.message}`;
          file.failedAt = new Date().toISOString();
        } else {
          batch.collectWarnings ||= [];
          batch.collectWarnings.push({
            error: error.message,
            at: new Date().toISOString(),
            row: row?.custom_id || null
          });
        }
      }
    }
    batch.outputDownloadedAt = new Date().toISOString();
  }

  if (batch.errorFileId && !batch.errorDownloadedAt) {
    const errorText = await downloadOpenAIFile(apiKey, batch.errorFileId);
    for (const line of errorText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const file = findFileForRow(manifest, batch, row, batchIndex);
      if (!file) continue;
      file.status = "failed";
      file.error = errorMessageFromRow(row);
      file.failedAt = new Date().toISOString();
    }
    batch.errorDownloadedAt = new Date().toISOString();
  }

  batch.completed = true;
  batch.status = "completed";
  batch.completedAt ||= new Date().toISOString();
  return true;
}

function markBatchCollectionError(manifest, batch, error) {
  batch.collectError = error.message || "Batch collection failed.";
  batch.collectErrorAt = new Date().toISOString();
  batch.collectAttempts = (Number(batch.collectAttempts) || 0) + 1;

  if (batch.collectAttempts < COLLECT_ERROR_LIMIT) return;

  batch.collectFinalError = batch.collectError;
  batch.status = "failed";
  batch.completed = true;
  batch.failedAt = new Date().toISOString();
  for (const item of batch.items || []) {
    const file = manifest.files[item.fileIndex];
    if (!file || file.status === "completed") continue;
    file.status = "failed";
    file.error = `Collector failed after ${COLLECT_ERROR_LIMIT} attempt(s): ${batch.collectFinalError}`;
    file.failedAt = new Date().toISOString();
  }
}

function syncIndexItem(index, manifest) {
  index.jobs ||= [];
  let item = index.jobs.find((job) => job.id === manifest.id);
  if (!item) {
    item = {
      id: manifest.id,
      createdAt: manifest.createdAt || new Date().toISOString()
    };
    index.jobs.unshift(item);
  }

  const summary = summarize(manifest);
  item.status = manifest.status;
  item.completed = summary.completed;
  item.failed = summary.failed;
  item.total = summary.total;
  item.updatedAt = new Date().toISOString();
  return item;
}

export default async function handler(req, res) {
  try {
    const secret = req.query?.secret || req.headers["x-cron-secret"] || "";
    checkCronSecret(secret);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

    const index = await readIndex();
    const cleaned = await cleanupExpiredHostedJobs(index);
    const onlyJobId = req.query?.jobId || "";
    const limit = Math.max(1, Math.min(25, Number(req.query?.limit) || HOSTED_MAX_COLLECT_BATCHES));
    let processed = 0;
    const touched = [];
    const jobsToVisit = onlyJobId ? [{ id: onlyJobId }] : index.jobs || [];

    for (const item of jobsToVisit) {
      if (cleaned.removed.some((job) => job.id === item.id)) continue;
      if (processed >= limit) break;
      const manifest = await readManifest(item.id);
      if (!manifest) {
        if (onlyJobId) {
          json(res, 404, { error: "Job not found.", jobId: onlyJobId });
          return;
        }
        continue;
      }

      const pendingBatches = manifest.batches.filter(batchNeedsCollection);
      if (!pendingBatches.length) {
        syncIndexItem(index, manifest);
        await writeManifest(manifest);
        touched.push(item.id);
        continue;
      }

      for (const batch of pendingBatches) {
        if (processed >= limit) break;
        try {
          await collectBatch({ apiKey, manifest, batch });
          batch.collectError = null;
          batch.collectAttempts = 0;
        } catch (error) {
          markBatchCollectionError(manifest, batch, error);
        }
        processed += 1;
      }
      syncIndexItem(index, manifest);
      await writeManifest(manifest);
      touched.push(item.id);
    }

    await writeIndex(index);
    json(res, 200, { ok: true, processed, limit, touched, cleaned: cleaned.removed, cleanupFailed: cleaned.failed });
  } catch (error) {
    const message = error.message || "Hosted cron failed.";
    if (/Vercel Blob: This store has been suspended/i.test(message)) {
      json(res, 200, { ok: false, paused: true, error: message });
      return;
    }
    json(res, 400, { error: message });
  }
}
