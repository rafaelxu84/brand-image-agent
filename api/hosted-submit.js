import {
  buildBatchLine,
  checkAccess,
  createJobId,
  json,
  readIndex,
  readJsonBody,
  safeName,
  uploadOpenAIFile,
  openaiJson,
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

    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!files.length) throw new Error("Upload at least one source image.");
    for (const file of files) {
      if (!file.sourceUrl) throw new Error("Each file needs sourceUrl.");
    }

    const jobId = payload.jobId || createJobId();
    const quality = normalizeQuality(payload.quality);
    const chunkSize = Math.max(1, Math.min(25, Number(payload.chunkSize) || 10));
    const model = process.env.OPENAI_TEXT_MODEL || "gpt-5.2";
    const batches = [];

    for (const [batchIndex, items] of chunk(files, chunkSize).entries()) {
      const batchItems = items.map((file, itemIndex) => ({
        fileIndex: batchIndex * chunkSize + itemIndex,
        customId: `${jobId}-${String(batchIndex + 1).padStart(3, "0")}-${String(itemIndex + 1).padStart(3, "0")}`
      }));
      const lines = batchItems.map((item) =>
        buildBatchLine({
          customId: item.customId,
          model,
          quality,
          brandName: payload.brandName || "",
          instructions: payload.instructions || "",
          sourceUrl: files[item.fileIndex].sourceUrl
        })
      );
      const inputFile = await uploadOpenAIFile(apiKey, {
        buffer: Buffer.from(`${lines.join("\n")}\n`),
        filename: `${jobId}-${String(batchIndex + 1).padStart(3, "0")}.jsonl`,
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
      batches.push({
        id: batch.id,
        inputFileId: inputFile.id,
        status: batch.status,
        requestCount: items.length,
        items: batchItems,
        outputFileId: null,
        errorFileId: null,
        completed: false,
        submittedAt: new Date().toISOString()
      });
    }

    const manifest = {
      id: jobId,
      mode: "hosted-openai-batch",
      status: "submitted",
      brandName: payload.brandName || "",
      instructions: payload.instructions || "",
      quality,
      chunkSize,
      createdAt: new Date().toISOString(),
      files: files.map((file, index) => ({
        id: `${jobId}-file-${String(index + 1).padStart(4, "0")}`,
        name: file.name || `cover-${index + 1}`,
        safeName: safeName(file.name || `cover-${index + 1}`),
        sourceUrl: file.sourceUrl,
        status: "submitted",
        outputUrl: null,
        error: null
      })),
      batches
    };
    await writeManifest(manifest);

    const index = await readIndex();
    index.jobs ||= [];
    index.jobs.unshift({
      id: jobId,
      status: manifest.status,
      total: manifest.files.length,
      completed: 0,
      failed: 0,
      createdAt: manifest.createdAt,
      updatedAt: manifest.createdAt
    });
    await writeIndex(index);

    json(res, 200, { jobId, manifest });
  } catch (error) {
    json(res, 400, { error: error.message || "Could not submit hosted batch." });
  }
}
