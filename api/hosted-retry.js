import {
  buildBatchLine,
  checkAccess,
  json,
  openaiJson,
  readIndex,
  readJsonBody,
  readManifest,
  uploadOpenAIFile,
  writeIndex,
  writeManifest
} from "./hosted-shared.js";

function normalizeQuality(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
    const payload = await readJsonBody(req);
    checkAccess(payload.accessCode || "");
    if (!payload.jobId) throw new Error("jobId is required.");

    const manifest = await readManifest(payload.jobId);
    if (!manifest) throw new Error("Job not found.");

    const failedItems = manifest.files
      .map((file, fileIndex) => ({ file, fileIndex }))
      .filter((item) => item.file.status === "failed");
    if (!failedItems.length) throw new Error("No failed images to retry.");

    const quality = normalizeQuality(payload.quality || manifest.quality);
    const chunkSize = Math.max(1, Math.min(25, Number(payload.chunkSize || manifest.chunkSize) || 10));
    const model = process.env.OPENAI_TEXT_MODEL || "gpt-5.2";
    const retryRound = (manifest.retryRound || 0) + 1;

    for (const [batchIndex, items] of chunk(failedItems, chunkSize).entries()) {
      const batchItems = items.map((item, itemIndex) => ({
        fileIndex: item.fileIndex,
        customId: `${manifest.id}-retry${String(retryRound).padStart(2, "0")}-${String(batchIndex + 1).padStart(3, "0")}-${String(itemIndex + 1).padStart(3, "0")}`
      }));
      const lines = batchItems.map((item) =>
        buildBatchLine({
          customId: item.customId,
          model,
          quality,
          brandName: manifest.brandName || "",
          instructions: payload.instructions || manifest.instructions || "",
          sourceUrl: manifest.files[item.fileIndex].sourceUrl
        })
      );
      const inputFile = await uploadOpenAIFile(apiKey, {
        buffer: Buffer.from(`${lines.join("\n")}\n`),
        filename: `${manifest.id}-retry${String(retryRound).padStart(2, "0")}-${String(batchIndex + 1).padStart(3, "0")}.jsonl`,
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

      manifest.batches.push({
        id: batch.id,
        inputFileId: inputFile.id,
        status: batch.status,
        requestCount: items.length,
        items: batchItems,
        outputFileId: null,
        errorFileId: null,
        completed: false,
        retryRound,
        submittedAt: new Date().toISOString()
      });
    }

    for (const item of failedItems) {
      item.file.status = "submitted";
      item.file.error = null;
      item.file.outputUrl = null;
      item.file.retriedAt = new Date().toISOString();
    }
    manifest.retryRound = retryRound;
    manifest.status = "running";
    await writeManifest(manifest);

    const index = await readIndex();
    const indexItem = (index.jobs || []).find((item) => item.id === manifest.id);
    if (indexItem) {
      indexItem.status = manifest.status;
      indexItem.failed = 0;
      indexItem.updatedAt = manifest.updatedAt;
      await writeIndex(index);
    }

    json(res, 200, { retried: failedItems.length, manifest });
  } catch (error) {
    json(res, 400, { error: error.message || "Could not retry failed hosted images." });
  }
}
