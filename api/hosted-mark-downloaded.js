import {
  checkAccess,
  cleanupAfterDate,
  json,
  readIndex,
  readJsonBody,
  readManifest,
  writeIndex,
  writeManifest
} from "./hosted-shared.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const payload = await readJsonBody(req);
    checkAccess(payload.accessCode || "");
    if (!payload.jobId) throw new Error("jobId is required.");

    const manifest = await readManifest(payload.jobId);
    if (!manifest) throw new Error("Job not found.");

    const completed = manifest.files.filter((file) => file.status === "completed").length;
    if (!completed) throw new Error("No completed images to mark as downloaded.");

    const downloadedAt = new Date().toISOString();
    manifest.downloadedAt = downloadedAt;
    manifest.cleanupAfter = cleanupAfterDate(downloadedAt);
    await writeManifest(manifest);

    const index = await readIndex();
    const indexItem = (index.jobs || []).find((item) => item.id === manifest.id);
    if (indexItem) {
      indexItem.downloadedAt = manifest.downloadedAt;
      indexItem.cleanupAfter = manifest.cleanupAfter;
      indexItem.updatedAt = manifest.updatedAt;
      await writeIndex(index);
    }

    json(res, 200, {
      ok: true,
      downloadedAt: manifest.downloadedAt,
      cleanupAfter: manifest.cleanupAfter,
      manifest
    });
  } catch (error) {
    json(res, 400, { error: error.message || "Could not mark hosted job as downloaded." });
  }
}
