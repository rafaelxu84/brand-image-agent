import { upload } from "https://esm.sh/@vercel/blob@latest/client";

const state = {
  files: [],
  jobId: new URLSearchParams(location.search).get("jobId") || localStorage.getItem("hosted.jobId") || "",
  manifest: null
};

const els = {
  accessCode: document.querySelector("#accessCode"),
  brandName: document.querySelector("#brandName"),
  imageInput: document.querySelector("#imageInput"),
  imageCount: document.querySelector("#imageCount"),
  quality: document.querySelector("#quality"),
  chunkSize: document.querySelector("#chunkSize"),
  instructions: document.querySelector("#instructions"),
  submitBtn: document.querySelector("#submitBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  collectBtn: document.querySelector("#collectBtn"),
  retryFailedBtn: document.querySelector("#retryFailedBtn"),
  downloadZipBtn: document.querySelector("#downloadZipBtn"),
  jobTitle: document.querySelector("#jobTitle"),
  jobMeta: document.querySelector("#jobMeta"),
  progress: document.querySelector("#progress"),
  status: document.querySelector("#status"),
  results: document.querySelector("#results")
};

for (const id of ["accessCode", "brandName", "quality", "chunkSize", "instructions"]) {
  const saved = localStorage.getItem(`hosted.${id}`);
  if (saved !== null) els[id].value = saved;
  els[id].addEventListener("input", () => localStorage.setItem(`hosted.${id}`, els[id].value));
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function safeName(name) {
  return (name || "cover")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "cover";
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function updateProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progress.value = pct;
  setStatus(`${label} ${done}/${total}`);
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function createZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const checksum = crc32(file.bytes);
    const localHeader = new Uint8Array([
      ...uint32(0x04034b50),
      ...uint16(20),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(checksum),
      ...uint32(file.bytes.length),
      ...uint32(file.bytes.length),
      ...uint16(nameBytes.length),
      ...uint16(0)
    ]);
    parts.push(localHeader, nameBytes, file.bytes);

    const centralHeader = new Uint8Array([
      ...uint32(0x02014b50),
      ...uint16(20),
      ...uint16(20),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(checksum),
      ...uint32(file.bytes.length),
      ...uint32(file.bytes.length),
      ...uint16(nameBytes.length),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(offset)
    ]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + file.bytes.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endHeader = new Uint8Array([
    ...uint32(0x06054b50),
    ...uint16(0),
    ...uint16(0),
    ...uint16(files.length),
    ...uint16(files.length),
    ...uint32(centralSize),
    ...uint32(offset),
    ...uint16(0)
  ]);
  return new Blob([...parts, ...centralParts, endHeader], { type: "application/zip" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function downloadCompletedZip() {
  const manifest = state.manifest;
  if (!manifest) throw new Error("Refresh a hosted job first.");
  const completed = manifest.files.filter((file) => file.outputUrl);
  if (!completed.length) throw new Error("No completed images to download yet.");

  const zipFiles = [];
  for (const [index, file] of completed.entries()) {
    setStatus(`Downloading completed images ${index + 1}/${completed.length}...`);
    const response = await fetch(file.outputUrl);
    if (!response.ok) throw new Error(`Could not download ${file.name}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    zipFiles.push({
      name: `${String(index + 1).padStart(3, "0")}-${safeName(file.name)}-ai-portrait.png`,
      bytes
    });
  }

  const zip = createZip(zipFiles);
  downloadBlob(zip, `${manifest.id || "hosted-covers"}-${dateStamp()}.zip`);
  setStatus(`Packed ${zipFiles.length} completed image(s) into ZIP. Registering cleanup...`);
  await markDownloaded();
}

async function markDownloaded() {
  const data = await postJson("/api/hosted-mark-downloaded", {
    jobId: state.jobId,
    accessCode: els.accessCode.value.trim()
  });
  renderManifest(data.manifest);
  setStatus(`ZIP downloaded. This hosted job will be cleaned after ${formatDateTime(data.cleanupAfter)}.`);
}

async function submitHostedJob() {
  if (!state.files.length) throw new Error("Upload at least one source image.");
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  state.jobId = jobId;
  localStorage.setItem("hosted.jobId", state.jobId);
  history.replaceState(null, "", `/hosted.html?jobId=${encodeURIComponent(state.jobId)}`);
  els.jobTitle.textContent = state.jobId;
  els.jobMeta.textContent = "Preparing uploads...";
  const accessCode = els.accessCode.value.trim();
  const uploaded = [];
  const totalSteps = state.files.length;
  let done = 0;

  for (const file of state.files) {
    const base = safeName(file.name);
    const clientPayload = JSON.stringify({ accessCode, jobId });
    const source = await upload(`hosted/jobs/${jobId}/sources/${base}${file.name.match(/\.[^.]+$/)?.[0] || ".png"}`, file, {
      access: "public",
      handleUploadUrl: "/api/hosted-upload",
      clientPayload
    });
    done += 1;
    updateProgress(done, totalSteps, "Uploaded assets");
    uploaded.push({ name: file.name, sourceUrl: source.url });
  }

  const result = await postJson("/api/hosted-submit", {
    accessCode,
    jobId,
    brandName: els.brandName.value.trim(),
    quality: els.quality.value,
    chunkSize: Number(els.chunkSize.value || 10),
    instructions: els.instructions.value.trim(),
    files: uploaded
  });
  state.jobId = result.jobId;
  localStorage.setItem("hosted.jobId", state.jobId);
  history.replaceState(null, "", `/hosted.html?jobId=${encodeURIComponent(state.jobId)}`);
  renderManifest(result.manifest);
}

function renderManifest(manifest) {
  state.manifest = manifest;
  const completed = manifest.files.filter((file) => file.status === "completed").length;
  const failed = manifest.files.filter((file) => file.status === "failed").length;
  const cleanupText = manifest.cleanupAfter ? ` · cleanup after ${formatDateTime(manifest.cleanupAfter)}` : "";
  els.jobTitle.textContent = manifest.id;
  els.jobMeta.textContent = `${manifest.status} · ${completed}/${manifest.files.length} completed · ${failed} failed${cleanupText}`;
  els.progress.value = manifest.files.length ? Math.round((completed / manifest.files.length) * 100) : 0;
  els.downloadZipBtn.disabled = completed === 0;
  els.retryFailedBtn.disabled = failed === 0;
  els.results.innerHTML = "";

  for (const file of manifest.files) {
    const row = document.createElement("article");
    row.className = "thumb";
    if (file.outputUrl) {
      const img = document.createElement("img");
      img.src = file.outputUrl;
      img.alt = file.name;
      row.append(img);
    }
    const title = document.createElement("strong");
    title.textContent = file.name;
    const meta = document.createElement("span");
    meta.textContent = file.error || file.status;
    row.append(title, meta);
    if (file.outputUrl) {
      const link = document.createElement("a");
      link.href = file.outputUrl;
      link.download = `${safeName(file.name)}-ai-portrait.png`;
      link.textContent = "Download";
      row.append(link);
    }
    els.results.append(row);
  }
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function refreshStatus() {
  if (!state.jobId) throw new Error("No hosted job id yet.");
  const url = `/api/hosted-status?jobId=${encodeURIComponent(state.jobId)}&code=${encodeURIComponent(els.accessCode.value.trim())}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not refresh status.");
  renderManifest(data.manifest);
  setStatus("Status refreshed.");
}

async function collectNow() {
  if (!state.jobId) throw new Error("No hosted job id yet.");
  const url = `/api/hosted-cron?jobId=${encodeURIComponent(state.jobId)}&secret=${encodeURIComponent(els.accessCode.value.trim())}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not collect results.");
  const touched = data.touched?.join(", ") || "no touched jobs";
  setStatus(`Collector ran: processed ${data.processed || 0} batch(es), ${touched}.`);
  await refreshStatus();
}

async function retryFailed() {
  if (!state.jobId) throw new Error("No hosted job id yet.");
  const data = await postJson("/api/hosted-retry", {
    jobId: state.jobId,
    accessCode: els.accessCode.value.trim(),
    quality: els.quality.value,
    chunkSize: Number(els.chunkSize.value || 10),
    instructions: els.instructions.value.trim()
  });
  renderManifest(data.manifest);
  setStatus(`Retried ${data.retried} failed image(s). You can close this page again.`);
}

els.imageInput.addEventListener("change", (event) => {
  state.files = Array.from(event.target.files || []);
  els.imageCount.textContent = state.files.length ? `${state.files.length} image(s) selected` : "No images selected";
});

els.submitBtn.addEventListener("click", async () => {
  els.submitBtn.disabled = true;
  try {
    await submitHostedJob();
    setStatus("Hosted job submitted. You can close this page now.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    els.submitBtn.disabled = false;
  }
});

els.refreshBtn.addEventListener("click", () => refreshStatus().catch((error) => setStatus(error.message, true)));
els.collectBtn.addEventListener("click", () => collectNow().catch((error) => setStatus(error.message, true)));
els.retryFailedBtn.addEventListener("click", () => retryFailed().catch((error) => setStatus(error.message, true)));
els.downloadZipBtn.addEventListener("click", () => downloadCompletedZip().catch((error) => setStatus(error.message, true)));

if (state.jobId) refreshStatus().catch(() => {});
