import { checkAccess, json, requireBlobToken } from "./hosted-shared.js";

export default async function handler(req, res) {
  try {
    const code = req.query?.code || req.body?.code || "";
    requireBlobToken();
    checkAccess(code);
    json(res, 200, { ok: true });
  } catch (error) {
    json(res, 400, { error: error.message || "Hosted setup validation failed." });
  }
}
