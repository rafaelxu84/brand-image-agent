import { del, list, put } from "@vercel/blob";
import sharp from "sharp";

export const HOSTED_ACCESS_ENV = "HOSTED_ACCESS_CODE";
export const HOSTED_CRON_ENV = "HOSTED_CRON_SECRET";
export const HOSTED_INDEX_PATH = "hosted/jobs/index.json";
export const HOSTED_MAX_COLLECT_BATCHES = 8;
export const HOSTED_OUTPUT_LIMIT = 400;
export const HOSTED_CLEANUP_AFTER_DOWNLOAD_DAYS = 5;

export const DESIGN = {
  width: 400,
  height: 533
};

export function json(res, status, data) {
  res.status(status).json(data);
}

export function requireBlobToken() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured. Create a Vercel Blob store for this project first.");
  }
}

export function checkAccess(code) {
  const expected = process.env[HOSTED_ACCESS_ENV];
  if (expected && code !== expected) throw new Error("Invalid hosted access code.");
}

export function checkCronSecret(secret) {
  const expected = process.env[HOSTED_CRON_ENV];
  const accessCode = process.env[HOSTED_ACCESS_ENV];
  if (expected && secret !== expected && secret !== accessCode) throw new Error("Invalid cron secret.");
}

export function safeName(name) {
  return (name || "cover")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "cover";
}

export function createJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function promptText({ brandName, instructions }) {
  return [
    "Create a premium iGaming portrait cover image from the first reference image.",
    brandName ? `Brand name: ${brandName}.` : "Brand name is unknown.",
    "Use the source image itself as the composition reference.",
    "Do not add any brand logo, provider logo, watermark, badge, UI label, footer plaque, or lower-left brand mark.",
    "Exact output layout: final visual is a 400px wide by 533px high canvas. The game title block must be centered and scaled to nearly fill the 360px safe width. If the title is smaller than 340px wide, enlarge it; if wider than 360px, shrink it. Target title width is 350-360px with crisp readable lettering.",
    "Golden composition rule: place the visual center of the game title block around y=329px on the 400x533 canvas. Acceptable title-center range is y=305-345px. Keep the title centered horizontally, large, exposed, and readable.",
    "Do not crop, trim, zoom into, or cut off important original source information. Keep full game title, top multipliers, upper decorations, corner characters, side creatures, main subject, and readable text visible. If space is tight, zoom out and extend/rebuild surrounding background.",
    "Create a cinematic lower dark/smoky/soft-gradient obstruction in the lower 14-22% that covers busy background detail but does not hide the game title.",
    "Preserve original title text as accurately as possible. Do not invent new words, buttons, UI, jackpot badges, watermarks, or borders.",
    "Make the result sharp, premium, balanced, readable, and commercially polished.",
    instructions ? `Additional direction: ${instructions}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildBatchLine({ customId, model, quality, brandName, instructions, sourceUrl }) {
  return JSON.stringify({
    custom_id: customId,
    method: "POST",
    url: "/v1/responses",
    body: {
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: promptText({ brandName, instructions }) },
            { type: "input_image", image_url: sourceUrl }
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
      ]
    }
  });
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

export async function putJson(pathname, data) {
  requireBlobToken();
  await put(pathname, `${JSON.stringify(data, null, 2)}\n`, {
    access: "public",
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60
  });
}

export async function readJsonBlob(pathname, fallback = null) {
  requireBlobToken();
  const result = await list({ prefix: pathname, limit: 1 });
  const item = result.blobs.find((blob) => blob.pathname === pathname);
  if (!item) return fallback;
  const response = await fetch(`${item.url}?t=${Date.now()}`);
  if (!response.ok) return fallback;
  return response.json();
}

export async function readIndex() {
  return readJsonBlob(HOSTED_INDEX_PATH, { jobs: [] });
}

export async function writeIndex(index) {
  const unique = new Map();
  for (const item of index.jobs || []) unique.set(item.id, item);
  index.jobs = [...unique.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  await putJson(HOSTED_INDEX_PATH, index);
}

export function manifestPath(jobId) {
  return `hosted/jobs/${jobId}/manifest.json`;
}

export async function readManifest(jobId) {
  return readJsonBlob(manifestPath(jobId), null);
}

export async function writeManifest(manifest) {
  manifest.updatedAt = new Date().toISOString();
  await putJson(manifestPath(manifest.id), manifest);
}

export function cleanupAfterDate(from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + HOSTED_CLEANUP_AFTER_DOWNLOAD_DAYS);
  return date.toISOString();
}

export function isCleanupDue(manifest, now = new Date()) {
  if (!manifest?.cleanupAfter || manifest.deletedAt) return false;
  return new Date(manifest.cleanupAfter).getTime() <= now.getTime();
}

async function listAllPathnames(prefix) {
  const pathnames = [];
  let cursor;
  do {
    const result = await list({ prefix, limit: 1000, cursor });
    pathnames.push(...result.blobs.map((blob) => blob.pathname));
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return pathnames;
}

export async function deleteHostedJobBlobs(jobId) {
  requireBlobToken();
  const prefix = `hosted/jobs/${jobId}/`;
  const pathnames = await listAllPathnames(prefix);
  const chunkSize = 100;
  for (let index = 0; index < pathnames.length; index += chunkSize) {
    await del(pathnames.slice(index, index + chunkSize));
  }
  return { deleted: pathnames.length, prefix };
}

export async function cleanupExpiredHostedJobs(index, now = new Date()) {
  const removed = [];
  const failed = [];
  const kept = [];

  for (const item of index.jobs || []) {
    const manifest = await readManifest(item.id);
    if (!manifest) {
      kept.push(item);
      continue;
    }
    if (!isCleanupDue(manifest, now)) {
      kept.push(item);
      continue;
    }

    try {
      const cleanup = await deleteHostedJobBlobs(item.id);
      removed.push({
        id: item.id,
        cleanupAfter: manifest.cleanupAfter,
        deleted: cleanup.deleted
      });
    } catch (error) {
      item.cleanupError = error.message || "Cleanup failed.";
      item.cleanupCheckedAt = now.toISOString();
      kept.push(item);
      failed.push({ id: item.id, error: item.cleanupError });
    }
  }

  if (removed.length) index.jobs = kept;
  return { removed, failed };
}

export async function openaiJson(apiKey, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.openai.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI ${method} ${pathname} failed with ${response.status}`);
  return data;
}

export async function uploadOpenAIFile(apiKey, { buffer, filename, purpose, contentType }) {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([buffer], { type: contentType }), filename);
  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI file upload failed with ${response.status}`);
  return data;
}

export async function downloadOpenAIFile(apiKey, fileId) {
  const response = await fetch(`https://api.openai.com/v1/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `OpenAI file download failed with ${response.status}`);
  return text;
}

export async function storeOutputPng({ jobId, name, base64 }) {
  const input = Buffer.from(base64, "base64");
  const png = await sharp(input).resize(DESIGN.width, DESIGN.height, { fit: "fill" }).png().toBuffer();
  return put(`hosted/jobs/${jobId}/outputs/${safeName(name)}-ai-portrait.png`, png, {
    access: "public",
    allowOverwrite: true,
    contentType: "image/png",
    cacheControlMaxAge: 60
  });
}

export default function handler(req, res) {
  json(res, 404, { error: "Not found" });
}
