import { checkAccess, json, readIndex, readManifest } from "./hosted-shared.js";

export default async function handler(req, res) {
  try {
    const { jobId, code } = req.query || {};
    checkAccess(code || "");
    if (jobId) {
      const manifest = await readManifest(jobId);
      if (!manifest) {
        json(res, 404, { error: "Job not found." });
        return;
      }
      json(res, 200, { manifest });
      return;
    }
    const index = await readIndex();
    json(res, 200, index);
  } catch (error) {
    json(res, 400, { error: error.message || "Could not read hosted status." });
  }
}
