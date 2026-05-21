import { handleUpload } from "@vercel/blob/client";
import { checkAccess, json, readJsonBody, requireBlobToken } from "./hosted-shared.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    requireBlobToken();
    const body = await readJsonBody(req);
    const response = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = clientPayload ? JSON.parse(clientPayload) : {};
        checkAccess(payload.accessCode || "");
        if (!String(pathname || "").startsWith(`hosted/jobs/${payload.jobId}/`)) {
          throw new Error("Invalid upload path.");
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
          maximumSizeInBytes: 30 * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: true,
          tokenPayload: JSON.stringify({ jobId: payload.jobId })
        };
      },
      onUploadCompleted: async () => {}
    });
    json(res, 200, response);
  } catch (error) {
    json(res, 400, { error: error.message || "Upload token failed" });
  }
}
