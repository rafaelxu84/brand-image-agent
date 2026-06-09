const state = {
  files: [],
  selectedIndex: 0,
  outputs: [],
  logoOutputs: [],
  outputMode: "",
  selectedOutput: null,
  logo: {
    dataUrl: "",
    image: null,
    name: ""
  }
};

const els = {
  brandName: document.querySelector("#brandName"),
  imageInput: document.querySelector("#imageInput"),
  imageCount: document.querySelector("#imageCount"),
  exportWidth: document.querySelector("#exportWidth"),
  footerRatio: document.querySelector("#footerRatio"),
  aiQuality: document.querySelector("#aiQuality"),
  instructions: document.querySelector("#instructions"),
  apiKey: document.querySelector("#apiKey"),
  logoInput: document.querySelector("#logoInput"),
  logoName: document.querySelector("#logoName"),
  removeLogoWhite: document.querySelector("#removeLogoWhite"),
  logoBgTolerance: document.querySelector("#logoBgTolerance"),
  logoBgToleranceValue: document.querySelector("#logoBgToleranceValue"),
  logoX: document.querySelector("#logoX"),
  logoY: document.querySelector("#logoY"),
  logoHeight: document.querySelector("#logoHeight"),
  logoOpacity: document.querySelector("#logoOpacity"),
  logoXValue: document.querySelector("#logoXValue"),
  logoYValue: document.querySelector("#logoYValue"),
  logoHeightValue: document.querySelector("#logoHeightValue"),
  logoOpacityValue: document.querySelector("#logoOpacityValue"),
  applyLogoBatchBtn: document.querySelector("#applyLogoBatchBtn"),
  downloadPressedLogoZipBtn: document.querySelector("#downloadPressedLogoZipBtn"),
  canvasBtn: document.querySelector("#canvasBtn"),
  batchBtn: document.querySelector("#batchBtn"),
  aiBtn: document.querySelector("#aiBtn"),
  aiBatchBtn: document.querySelector("#aiBatchBtn"),
  downloadAllBtn: document.querySelector("#downloadAllBtn"),
  status: document.querySelector("#status"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedMeta: document.querySelector("#selectedMeta"),
  sourcePreview: document.querySelector("#sourcePreview"),
  previewCanvas: document.querySelector("#previewCanvas"),
  aiPreview: document.querySelector("#aiPreview"),
  logoOverlay: document.querySelector("#logoOverlay"),
  results: document.querySelector("#results")
};

const isStaticDemo = location.hostname.endsWith("github.io");
const MAX_AI_PAYLOAD_CHARS = 3.7 * 1024 * 1024;
const DESIGN_SIZE = { width: 400, height: 533 };
const DESIGN_FOOTER_HEIGHT = 116;
const DESIGN_TITLE_MAX_WIDTH = 360;
const DESIGN_TITLE_CENTER_Y = Math.round(DESIGN_SIZE.height * 0.618);

if (isStaticDemo) {
  els.aiBtn.disabled = true;
  els.aiBatchBtn.disabled = true;
  els.aiBtn.title = "AI cover generation needs the Vercel serverless API.";
  els.aiBatchBtn.title = "AI cover generation needs the Vercel serverless API.";
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function normalizeLogoFile(file) {
  let bitmap = null;
  if ("createImageBitmap" in window) {
    bitmap = await createImageBitmap(file, {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none"
    }).catch(() => null);
  }

  if (!bitmap) {
    const fallbackUrl = await fileToDataUrl(file);
    bitmap = await loadImage(fallbackUrl);
  }

  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  let transparent = 0;
  let translucent = 0;
  for (let index = 3; index < imageData.data.length; index += 4) {
    const alpha = imageData.data[index];
    if (alpha === 0) transparent += 1;
    else if (alpha < 255) translucent += 1;
  }

  bitmap.close?.();
  const pixels = width * height;
  return {
    dataUrl: canvas.toDataURL("image/png"),
    alpha: {
      transparent,
      translucent,
      pixels,
      transparentPct: pixels ? Math.round(((transparent + translucent) / pixels) * 100) : 0
    }
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image."));
    img.src = src;
  });
}

async function compressImageForApi(source, maxSide, mime = "image/jpeg", quality = 0.84) {
  const src = source instanceof File ? await fileToDataUrl(source) : source;
  const img = await loadImage(src);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = width;
  canvas.height = height;

  if (mime === "image/jpeg") {
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL(mime, quality);
}

async function resizeDataUrl(dataUrl, size = DESIGN_SIZE) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = size.width;
  canvas.height = size.height;
  ctx.drawImage(img, 0, 0, size.width, size.height);
  return canvas.toDataURL("image/png", 0.96);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const cleanText = text.trim() || response.statusText || "Request failed";
    return {
      error: cleanText.startsWith("Request Entity")
        ? "The image request is too large. The app now compresses images automatically; try a smaller source image if this persists."
        : cleanText
    };
  }
}

function apiErrorMessage(data, fallback = "Request failed") {
  const base = data?.error || fallback;
  const details = [];
  if (Array.isArray(data?.outputTypes) && data.outputTypes.length) {
    details.push(`OpenAI output: ${data.outputTypes.join(" | ")}`);
  }
  if (data?.message) details.push(data.message);
  if (data?.revisedPrompt) details.push(`Prompt: ${data.revisedPrompt}`);
  return details.length ? `${base} ${details.join(" ")}` : base;
}

function coverRect(sourceW, sourceH, destW, destH) {
  const scale = Math.max(destW / sourceW, destH / sourceH);
  const width = sourceW * scale;
  const height = sourceH * scale;
  return {
    x: (destW - width) / 2,
    y: (destH - height) / 2,
    width,
    height
  };
}

function drawCover(ctx, img, x, y, width, height) {
  const rect = coverRect(img.naturalWidth, img.naturalHeight, width, height);
  ctx.drawImage(img, x + rect.x, y + rect.y, rect.width, rect.height);
}

function drawHeightFit(ctx, img, width, height) {
  const scale = height / img.naturalHeight;
  const imageW = img.naturalWidth * scale;
  const imageH = height;
  const x = (width - imageW) / 2;
  ctx.drawImage(img, x, 0, imageW, imageH);
}

function drawContain(ctx, img, x, y, width, height, alignY = 0.46) {
  const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
  const imageW = img.naturalWidth * scale;
  const imageH = img.naturalHeight * scale;
  const drawX = x + (width - imageW) / 2;
  const drawY = y + (height - imageH) * alignY;
  ctx.drawImage(img, drawX, drawY, imageW, imageH);
}

function getOutputSize() {
  return { ...DESIGN_SIZE };
}

function logoSettings() {
  return {
    x: Number(els.logoX.value || 0),
    y: Number(els.logoY.value || 0),
    height: Number(els.logoHeight.value || 70),
    opacity: Number(els.logoOpacity.value || 100) / 100
  };
}

function logoDrawSize(logo, settings = logoSettings()) {
  const height = Math.max(1, Number(settings.height) || 70);
  const width = height * (logo.naturalWidth / logo.naturalHeight);
  return { width, height };
}

function updateLogoControlLabels() {
  const settings = logoSettings();
  els.logoXValue.textContent = `${Math.round(settings.x)}px`;
  els.logoYValue.textContent = `${Math.round(settings.y)}px`;
  els.logoHeightValue.textContent = `${Math.round(settings.height)}px`;
  els.logoOpacityValue.textContent = `${Math.round(settings.opacity * 100)}%`;
  els.logoBgToleranceValue.textContent = String(els.logoBgTolerance.value || 48);
}

function updateLogoButtons() {
  els.applyLogoBatchBtn.disabled = !state.files.length || !state.logo.image;
  els.downloadPressedLogoZipBtn.disabled = !state.logoOutputs.length;
}

function logoDisplayUrl() {
  return state.logo.processedDataUrl || state.logo.dataUrl;
}

function hasLogoPreviewBase() {
  return Boolean(state.selectedOutput || state.files[state.selectedIndex]);
}

function updateLogoOverlay() {
  if (!state.logo.image || !hasLogoPreviewBase()) {
    els.logoOverlay.hidden = true;
    els.logoOverlay.removeAttribute("src");
    return;
  }

  const settings = logoSettings();
  const size = logoDrawSize(state.logo.image, settings);
  els.logoOverlay.src = logoDisplayUrl();
  els.logoOverlay.hidden = false;
  els.logoOverlay.style.backgroundColor = "transparent";
  els.logoOverlay.style.left = `${(settings.x / DESIGN_SIZE.width) * 100}%`;
  els.logoOverlay.style.top = `${(settings.y / DESIGN_SIZE.height) * 100}%`;
  els.logoOverlay.style.width = "auto";
  els.logoOverlay.style.height = `${(size.height / DESIGN_SIZE.height) * 100}%`;
  els.logoOverlay.style.opacity = String(settings.opacity);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function moveLogoFromPointer(event) {
  if (!state.logo.image || els.logoOverlay.hidden) return;
  const rect = els.logoOverlay.parentElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const settings = logoSettings();
  const logoSize = logoDrawSize(state.logo.image, settings);
  const x = ((event.clientX - rect.left) / rect.width) * DESIGN_SIZE.width - logoSize.width / 2;
  const y = ((event.clientY - rect.top) / rect.height) * DESIGN_SIZE.height - logoSize.height / 2;

  els.logoX.value = Math.round(clamp(x, 0, DESIGN_SIZE.width - logoSize.width));
  els.logoY.value = Math.round(clamp(y, 0, DESIGN_SIZE.height - logoSize.height));
  const cleared = clearPressedLogoResults("Logo placement changed. Apply logo to all uploaded images again before downloading.");
  updateLogoControlLabels();
  updateLogoOverlay();
  if (cleared) {
    previewCurrentSourceWithLogo().catch(() => {});
  } else {
    refreshBrandedPreview().catch(() => {});
  }
}

async function composeLogoDataUrl(outputUrl) {
  if (!state.logo.image) return outputUrl;
  const base = await loadImage(outputUrl);
  const settings = logoSettings();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = DESIGN_SIZE.width;
  canvas.height = DESIGN_SIZE.height;

  ctx.drawImage(base, 0, 0, DESIGN_SIZE.width, DESIGN_SIZE.height);

  const logo = state.logo.processedImage || state.logo.image;
  const { width, height } = logoDrawSize(logo, settings);
  const x = Math.max(-width, Math.min(DESIGN_SIZE.width, settings.x));
  const y = Math.max(-height, Math.min(DESIGN_SIZE.height, settings.y));

  ctx.save();
  ctx.globalAlpha = settings.opacity;
  ctx.drawImage(logo, x, y, width, height);
  ctx.restore();

  return canvas.toDataURL("image/png", 0.96);
}

async function removeWhiteLogoBackground(dataUrl) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const width = canvas.width;
  const height = canvas.height;
  const tolerance = Number(els.logoBgTolerance.value || 48);
  const visited = new Uint8Array(width * height);
  const queue = [];

  function pixelIndex(x, y) {
    return y * width + x;
  }

  function dataIndex(x, y) {
    return pixelIndex(x, y) * 4;
  }

  function rgbAt(x, y) {
    const index = dataIndex(x, y);
    return [data[index], data[index + 1], data[index + 2], data[index + 3]];
  }

  const cornerSamples = [
    rgbAt(0, 0),
    rgbAt(width - 1, 0),
    rgbAt(0, height - 1),
    rgbAt(width - 1, height - 1)
  ].filter((pixel) => pixel[3] > 0);
  const background = cornerSamples.length
    ? cornerSamples.reduce(
        (sum, pixel) => [sum[0] + pixel[0], sum[1] + pixel[1], sum[2] + pixel[2]],
        [0, 0, 0]
      ).map((value) => value / cornerSamples.length)
    : [255, 255, 255];

  function isBackgroundLike(x, y) {
    const index = dataIndex(x, y);
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const a = data[index + 3];
    if (a === 0) return true;

    const dr = r - background[0];
    const dg = g - background[1];
    const db = b - background[2];
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    const whiteness = Math.min(r, g, b);
    const colorSpread = Math.max(r, g, b) - whiteness;
    return distance <= tolerance || (whiteness > 220 - tolerance * 0.25 && colorSpread < 38 + tolerance * 0.2);
  }

  function push(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = pixelIndex(x, y);
    if (visited[index]) return;
    visited[index] = 1;
    if (isBackgroundLike(x, y)) queue.push([x, y]);
  }

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [x, y] = queue[cursor];
    data[dataIndex(x, y) + 3] = 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  const originalAlpha = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    originalAlpha[index] = data[index * 4 + 3];
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = pixelIndex(x, y);
      if (originalAlpha[index] === 0) continue;
      const nearTransparent =
        originalAlpha[pixelIndex(x + 1, y)] === 0 ||
        originalAlpha[pixelIndex(x - 1, y)] === 0 ||
        originalAlpha[pixelIndex(x, y + 1)] === 0 ||
        originalAlpha[pixelIndex(x, y - 1)] === 0;
      if (nearTransparent && isBackgroundLike(x, y)) {
        data[index * 4 + 3] = Math.min(data[index * 4 + 3], 80);
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function updateLogoWhiteRemoval() {
  if (!state.logo.dataUrl) return;
  if (!els.removeLogoWhite.checked) {
    state.logo.processedDataUrl = "";
    state.logo.processedImage = null;
    updateLogoOverlay();
    await refreshBrandedPreview();
    return;
  }

  const processedDataUrl = await removeWhiteLogoBackground(state.logo.dataUrl);
  state.logo.processedDataUrl = processedDataUrl;
  state.logo.processedImage = await loadImage(processedDataUrl);
  updateLogoOverlay();
  await refreshBrandedPreview();
}

async function refreshBrandedPreview() {
  if (!state.selectedOutput) return;
  els.aiPreview.src = state.selectedOutput.outputUrl;
  updateLogoOverlay();
}

async function previewCurrentSourceWithLogo() {
  const file = state.files[state.selectedIndex];
  if (!file) return false;
  const sourceUrl = await fileToDataUrl(file);
  const outputUrl = await resizeDataUrl(sourceUrl);
  showOutput({
    name: `${file.name.replace(/\.[^.]+$/, "")}-logo-preview`,
    sourceUrl,
    outputUrl,
    width: DESIGN_SIZE.width,
    height: DESIGN_SIZE.height
  });
  return true;
}

async function ensureLogoPreviewTarget() {
  if (state.selectedOutput) return true;
  return previewCurrentSourceWithLogo();
}

async function generateCanvasOutput(file, previewOnly = false, options = {}) {
  const sourceUrl = await fileToDataUrl(file);
  const sourceImg = await loadImage(sourceUrl);
  const size = options.size || (previewOnly ? { width: 400, height: 533 } : getOutputSize());
  const scale = size.width / DESIGN_SIZE.width;
  const footerH = Math.round(DESIGN_FOOTER_HEIGHT * scale);
  const canvas = previewOnly ? els.previewCanvas : document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = size.width;
  canvas.height = size.height;

  ctx.clearRect(0, 0, size.width, size.height);

  ctx.save();
  ctx.filter = `blur(${Math.round(size.width * 0.02)}px) saturate(1.12)`;
  drawCover(ctx, sourceImg, -size.width * 0.04, -size.height * 0.04, size.width * 1.08, size.height * 1.08);
  ctx.restore();

  if (options.protectArtwork) {
    const artTop = Math.round(12 * scale);
    const artHeight = Math.round((DESIGN_TITLE_CENTER_Y + 118) * scale);
    drawContain(ctx, sourceImg, 0, artTop, size.width, artHeight, 0.5);
  } else {
    drawHeightFit(ctx, sourceImg, size.width, size.height);
  }

  const fade = ctx.createLinearGradient(0, size.height - footerH * 1.25, 0, size.height);
  fade.addColorStop(0, "rgba(10, 10, 8, 0)");
  fade.addColorStop(0.58, "rgba(20, 15, 10, 0.48)");
  fade.addColorStop(1, "rgba(6, 8, 12, 0.82)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, Math.max(0, size.height - footerH * 1.25), size.width, size.height);

  const vignette = ctx.createRadialGradient(
    size.width / 2,
    size.height * 0.45,
    size.width * 0.18,
    size.width / 2,
    size.height * 0.5,
    size.width * 0.78
  );
  vignette.addColorStop(0, "rgba(255, 255, 255, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.32)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size.width, size.height);

  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    sourceUrl,
    outputUrl: canvas.toDataURL(options.mime || "image/png", options.quality ?? 0.96),
    width: size.width,
    height: size.height
  };
}

function selectImage(index) {
  state.selectedIndex = index;
  state.selectedOutput = null;
  const file = state.files[index];
  els.aiPreview.hidden = true;
  els.previewCanvas.hidden = false;
  updateLogoOverlay();
  if (!file) {
    els.selectedTitle.textContent = "No image selected";
    els.selectedMeta.textContent = "Upload assets to begin.";
    els.sourcePreview.removeAttribute("src");
    updateLogoOverlay();
    return;
  }
  els.selectedTitle.textContent = file.name;
  els.selectedMeta.textContent = `${Math.round(file.size / 1024)} KB`;
  fileToDataUrl(file).then((url) => {
    els.sourcePreview.src = url;
  });
  if (state.logo.image) {
    previewCurrentSourceWithLogo().catch(() => generateCanvasOutput(file, true).catch(() => {}));
  } else {
    generateCanvasOutput(file, true).catch(() => {});
  }
}

function showOutput(item) {
  state.selectedOutput = item;
  els.selectedTitle.textContent = item.name;
  els.selectedMeta.textContent = `${item.width} x ${item.height}`;
  els.sourcePreview.src = item.sourceUrl;
  els.aiPreview.src = item.outputUrl;
  els.aiPreview.hidden = false;
  els.previewCanvas.hidden = true;
  updateLogoOverlay();
  refreshBrandedPreview().catch(() => {
    els.aiPreview.src = item.outputUrl;
    updateLogoOverlay();
  });
}

function renderResults() {
  els.results.innerHTML = "";
  els.downloadAllBtn.disabled = state.outputs.length === 0;
  updateLogoButtons();

  state.outputs.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "thumb";

    const img = document.createElement("img");
    img.src = item.outputUrl;
    img.alt = item.name;

    const title = document.createElement("strong");
    title.textContent = item.name;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download";
    button.addEventListener("click", () => downloadImage(item.outputUrl, `${item.name}-portrait.png`));

    card.addEventListener("click", () => showOutput(item));
    card.append(img, title, button);
    els.results.append(card);
  });
}

function downloadImage(dataUrl, filename) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function sanitizeFilename(name) {
  return (name || "cover")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "cover";
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes())
  ].join("");
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

function dataUrlToBytes(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  if (!base64) throw new Error("Generated image data is invalid.");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const ext = header.includes("image/jpeg") ? "jpg" : "png";
  return { bytes, ext };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
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

function downloadOutputsZip() {
  try {
    if (!state.outputs.length) throw new Error("Generate at least one cover first.");
    const usedNames = new Map();
    const files = state.outputs.map((item, index) => {
      const { bytes, ext } = dataUrlToBytes(item.outputUrl);
      const baseName = sanitizeFilename(item.name || `cover-${index + 1}`);
      const count = usedNames.get(baseName) || 0;
      usedNames.set(baseName, count + 1);
      const suffix = count ? `-${count + 1}` : "";
      return {
        name: `${String(index + 1).padStart(2, "0")}-${baseName}${suffix}.${ext}`,
        bytes
      };
    });
    const blob = createZip(files);
    const url = URL.createObjectURL(blob);
    downloadImage(url, `igaming-covers-${dateStamp()}.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus(`Packed ${files.length} cover(s) into ZIP.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function clearPressedLogoResults(message = "") {
  if (!state.logoOutputs.length) return false;
  state.logoOutputs = [];
  if (state.outputMode === "logo") {
    state.outputs = [];
    state.selectedOutput = null;
    renderResults();
  } else {
    updateLogoButtons();
  }
  if (message) setStatus(message);
  return true;
}

async function applyLogoToUploadedImages() {
  try {
    if (!state.files.length) throw new Error("Upload cover images first.");
    if (!state.logo.image) throw new Error("Upload a logo first.");

    state.logoOutputs = [];
    state.outputs = [];
    state.outputMode = "logo";
    renderResults();

    for (let index = 0; index < state.files.length; index += 1) {
      const file = state.files[index];
      setStatus(`Applying logo ${index + 1}/${state.files.length}...`);
      const sourceUrl = await fileToDataUrl(file);
      const baseUrl = await resizeDataUrl(sourceUrl);
      const outputUrl = await composeLogoDataUrl(baseUrl);
      const item = {
        name: `${file.name.replace(/\.[^.]+$/, "")}-logo`,
        sourceUrl,
        outputUrl,
        width: DESIGN_SIZE.width,
        height: DESIGN_SIZE.height,
        logoApplied: true
      };
      state.logoOutputs.push(item);
      state.outputs.push(item);
      if ((index + 1) % 12 === 0) {
        renderResults();
        await nextFrame();
      }
    }

    renderResults();
    if (state.logoOutputs[0]) showOutput(state.logoOutputs[0]);
    updateLogoButtons();
    setStatus(`Logo applied to ${state.logoOutputs.length} uploaded image(s). Ready to download.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function downloadPressedLogoZip() {
  if (!state.logoOutputs.length) {
    setStatus("Apply logo to uploaded images first.", true);
    return;
  }
  downloadOutputsZip();
}

async function generateBatch() {
  try {
    if (!state.files.length) throw new Error("Upload at least one source image.");

    setStatus(`Generating ${state.files.length} canvas image(s)...`);
    state.outputs = [];
    state.logoOutputs = [];
    state.outputMode = "generated";
    for (const file of state.files) {
      const output = await generateCanvasOutput(file);
      state.outputs.push(output);
      setStatus(`Generated ${state.outputs.length}/${state.files.length}.`);
    }
    renderResults();
    if (state.outputs[0]) {
      showOutput(state.outputs[0]);
    }
    setStatus("Canvas batch ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function expandSelected() {
  try {
    const file = state.files[state.selectedIndex];
    if (!file) throw new Error("Select a source image first.");

    setStatus("Expanding selected image...");
    const output = await generateCanvasOutput(file);
    state.logoOutputs = [];
    state.outputMode = "generated";
    state.outputs.unshift(output);
    renderResults();
    showOutput(output);
    setStatus("Selected image expanded.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function generateAiForFile(file) {
  setStatus(`Compressing ${file.name} for AI...`);
  const [sourceImage, referenceOutput] = await Promise.all([
      compressImageForApi(file, 1280, "image/jpeg", 0.84),
      generateCanvasOutput(file, false, {
        size: { width: 400, height: 533 },
        mime: "image/jpeg",
        quality: 0.8,
        protectArtwork: true
      })
  ]);

  const guideText = [
    "Use the second reference image as the exact cover layout guide.",
    "Treat this as static game-catalog artwork resizing and composition. Do not create a gambling interface, betting slip, odds board, payout promise, real-money promotion, call-to-action button, or new jackpot/winnings claim.",
    "Follow the exact 400x533 coordinate standard from the guide. Game title visual block must be scaled to nearly fill the 360px title safe width. If the title is smaller than 340px wide, enlarge it; if it is wider than 360px, shrink it. Target title width is 350-360px.",
    "Golden composition: place the visual center of the game title block around y=329px on the 400x533 canvas. Acceptable title-center range is y=305-345px. Keep title centered horizontally and highly readable.",
    "Do not add any brand logo, provider logo, watermark, footer plaque, or lower-left mark.",
    "Keep all important source artwork visible: top text, multipliers, upper decorations, edge/corner subjects, side subjects, main subject, and full game title.",
    "Do not zoom in or crop the original information. If space is tight, zoom out and extend the environment/background.",
    "Improve the lower mask so it feels like natural smoke, shadow, or lighting from the original image, but do not cover the title."
  ].join(" ");

  const quality = els.aiQuality.value || "medium";
  setStatus(`Generating ${quality} AI cover for ${file.name}...`);
  const payload = {
    brandName: els.brandName.value.trim(),
    instructions: [guideText, els.instructions.value.trim()].filter(Boolean).join("\n"),
    sourceImage,
    referenceImage: referenceOutput.outputUrl,
    apiKey: els.apiKey.value.trim(),
    quality
  };
  const body = JSON.stringify(payload);
  if (body.length > MAX_AI_PAYLOAD_CHARS) {
    throw new Error("The selected assets are still too large for the AI request. Try a smaller or more compressed source image.");
  }

  const response = await fetch("/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body
  });
  const data = await readJsonResponse(response);
  if (!response.ok) throw new Error(apiErrorMessage(data, "AI generation failed."));

  const finalImage = await resizeDataUrl(data.image);
  return {
    name: `${file.name.replace(/\.[^.]+$/, "")}-ai`,
    sourceUrl: sourceImage,
    outputUrl: finalImage,
    width: DESIGN_SIZE.width,
    height: DESIGN_SIZE.height,
    revisedPrompt: data.revisedPrompt || null
  };
}

async function generateAiSelected() {
  els.aiBtn.disabled = true;
  els.aiBatchBtn.disabled = true;
  try {
    const file = state.files[state.selectedIndex];
    if (!file) throw new Error("Select a source image first.");

    const output = await generateAiForFile(file);
    state.logoOutputs = [];
    state.outputMode = "generated";
    state.outputs.unshift(output);
    renderResults();
    showOutput(state.outputs[0]);
    setStatus(output.revisedPrompt ? "AI image ready with revised prompt." : "AI image ready.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    if (!isStaticDemo) {
      els.aiBtn.disabled = false;
      els.aiBatchBtn.disabled = false;
    }
  }
}

async function generateAiBatch() {
  els.aiBtn.disabled = true;
  els.aiBatchBtn.disabled = true;
  try {
    if (!state.files.length) throw new Error("Upload at least one source image.");

    state.outputs = [];
    state.logoOutputs = [];
    state.outputMode = "generated";
    for (let index = 0; index < state.files.length; index += 1) {
      setStatus(`AI cover ${index + 1}/${state.files.length}...`);
      const output = await generateAiForFile(state.files[index]);
      state.outputs.push(output);
      renderResults();
      showOutput(output);
    }
    setStatus(`AI batch ready: ${state.outputs.length}/${state.files.length}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    if (!isStaticDemo) {
      els.aiBtn.disabled = false;
      els.aiBatchBtn.disabled = false;
    }
  }
}

els.imageInput.addEventListener("change", (event) => {
  state.files = Array.from(event.target.files || []);
  state.outputs = [];
  state.logoOutputs = [];
  state.outputMode = "";
  state.selectedOutput = null;
  els.imageCount.textContent = state.files.length ? `${state.files.length} image(s) selected` : "No images selected";
  renderResults();
  selectImage(0);
});

els.logoInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const normalized = await normalizeLogoFile(file);
    const dataUrl = normalized.dataUrl;
    const image = await loadImage(dataUrl);
    state.logo = {
      dataUrl,
      image,
      name: file.name,
      alpha: normalized.alpha,
      processedDataUrl: "",
      processedImage: null
    };
    els.logoName.textContent = file.name;
    clearPressedLogoResults();
    updateLogoButtons();
    await updateLogoWhiteRemoval();
    const hasPreviewTarget = await ensureLogoPreviewTarget();
    await refreshBrandedPreview();
    updateLogoOverlay();
    setStatus(
      hasPreviewTarget
        ? `Logo loaded with ${normalized.alpha.transparentPct}% transparent/translucent pixels. Adjust position and size, then apply it to all uploaded images.`
        : `Logo loaded with ${normalized.alpha.transparentPct}% transparent/translucent pixels. Upload or select a cover to preview placement before starting.`
    );
  } catch (error) {
    setStatus(error.message, true);
  }
});

els.removeLogoWhite.addEventListener("change", () => {
  clearPressedLogoResults();
  updateLogoWhiteRemoval()
    .then(() => {
      setStatus(
        els.removeLogoWhite.checked
          ? "Logo edge background removal is on. Adjust tolerance if the preview still shows a plate."
          : "Using the original logo alpha channel."
      );
    })
    .catch((error) => setStatus(error.message, true));
});

els.logoBgTolerance.addEventListener("input", () => {
  updateLogoControlLabels();
  if (!els.removeLogoWhite.checked) return;
  clearPressedLogoResults();
  updateLogoWhiteRemoval().catch((error) => setStatus(error.message, true));
});

for (const input of [els.logoX, els.logoY, els.logoHeight, els.logoOpacity]) {
  input.addEventListener("input", () => {
    updateLogoControlLabels();
    const cleared = clearPressedLogoResults("Logo placement changed. Apply logo to all uploaded images again before downloading.");
    updateLogoOverlay();
    if (cleared) {
      previewCurrentSourceWithLogo().catch(() => {});
    } else {
      refreshBrandedPreview().catch(() => {});
    }
  });
}

let isDraggingLogo = false;
els.logoOverlay.addEventListener("pointerdown", (event) => {
  if (!state.logo.image || els.logoOverlay.hidden) return;
  isDraggingLogo = true;
  els.logoOverlay.setPointerCapture?.(event.pointerId);
  moveLogoFromPointer(event);
});
els.logoOverlay.addEventListener("pointermove", (event) => {
  if (!isDraggingLogo) return;
  moveLogoFromPointer(event);
});
els.logoOverlay.addEventListener("pointerup", () => {
  isDraggingLogo = false;
});
els.logoOverlay.addEventListener("pointercancel", () => {
  isDraggingLogo = false;
});

for (const input of [els.exportWidth, els.footerRatio]) {
  input.addEventListener("input", () => selectImage(state.selectedIndex));
}

updateLogoControlLabels();
els.canvasBtn.addEventListener("click", expandSelected);
els.batchBtn.addEventListener("click", generateBatch);
els.aiBtn.addEventListener("click", generateAiSelected);
els.aiBatchBtn.addEventListener("click", generateAiBatch);
els.downloadAllBtn.addEventListener("click", downloadOutputsZip);
els.applyLogoBatchBtn.addEventListener("click", applyLogoToUploadedImages);
els.downloadPressedLogoZipBtn.addEventListener("click", downloadPressedLogoZip);
