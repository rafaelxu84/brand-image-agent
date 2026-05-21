import {
  HOSTED_MAX_COLLECT_BATCHES,
  checkCronSecret,
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

function summarize(manifest) {
  const completed = manifest.files.filter((file) => file.status === "completed").length;
  const failed = manifest.files.filter((file) => file.status === "failed").length;
  const running = manifest.files.some((file) => file.status === "submitted" || file.status === "running");
  const active = manifest.batches.some((batch) => !["completed", "failed", "expired", "cancelled"].includes(batch.status));
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

async function collectBatch({ apiKey, manifest, batch }) {
  const remote = await openaiJson(apiKey, `/batches/${batch.id}`);
  batch.status = remote.status;
  batch.outputFileId = remote.output_file_id || batch.outputFileId || null;
  batch.errorFileId = remote.error_file_id || batch.errorFileId || null;
  batch.requestCounts = remote.request_counts || batch.requestCounts || null;
  batch.checkedAt = new Date().toISOString();

  if (remote.status !== "completed") {
    if (["failed", "expired", "cancelled"].includes(remote.status)) {
      for (const file of manifest.files.filter((item) => item.status !== "completed")) {
        file.status = "failed";
        file.error = `Batch ${remote.status}`;
      }
    }
    return false;
  }

  if (!batch.outputFileId || batch.completed) return true;

  const outputText = await downloadOpenAIFile(apiKey, batch.outputFileId);
  for (const line of outputText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const batchIndex = manifest.batches.findIndex((item) => item.id === batch.id);
    const file = findFileForRow(manifest, batch, row, batchIndex);
    if (!file) continue;

    if (row.error || row.response?.status_code >= 400) {
      file.status = "failed";
      file.error = row.error?.message || row.response?.body?.error?.message || "OpenAI batch request failed.";
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
  }

  batch.completed = true;
  batch.status = "completed";
  batch.completedAt = new Date().toISOString();
  return true;
}

export default async function handler(req, res) {
  try {
    const secret = req.query?.secret || req.headers["x-cron-secret"] || "";
    checkCronSecret(secret);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

    const index = await readIndex();
    const onlyJobId = req.query?.jobId || "";
    let processed = 0;
    const touched = [];

    for (const item of index.jobs || []) {
      if (onlyJobId && item.id !== onlyJobId) continue;
      if (processed >= HOSTED_MAX_COLLECT_BATCHES) break;
      const manifest = await readManifest(item.id);
      if (!manifest) continue;

      const nextBatch = manifest.batches.find((batch) => !batch.completed && !["failed", "expired", "cancelled"].includes(batch.status));
      if (!nextBatch) {
        const summary = summarize(manifest);
        item.status = manifest.status;
        item.completed = summary.completed;
        item.failed = summary.failed;
        item.total = summary.total;
        item.updatedAt = new Date().toISOString();
        await writeManifest(manifest);
        touched.push(item.id);
        continue;
      }

      await collectBatch({ apiKey, manifest, batch: nextBatch });
      const summary = summarize(manifest);
      item.status = manifest.status;
      item.completed = summary.completed;
      item.failed = summary.failed;
      item.total = summary.total;
      item.updatedAt = new Date().toISOString();
      await writeManifest(manifest);
      touched.push(item.id);
      processed += 1;
    }

    await writeIndex(index);
    json(res, 200, { ok: true, processed, touched });
  } catch (error) {
    json(res, 400, { error: error.message || "Hosted cron failed." });
  }
}
