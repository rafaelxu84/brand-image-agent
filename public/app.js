const state = {
  files: [],
  selectedIndex: 0,
  outputs: []
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
  const file = state.files[index];
  els.aiPreview.hidden = true;
  els.previewCanvas.hidden = false;
  if (!file) {
    els.selectedTitle.textContent = "No image selected";
    els.selectedMeta.textContent = "Upload assets to begin.";
    els.sourcePreview.removeAttribute("src");
    return;
  }
  els.selectedTitle.textContent = file.name;
  els.selectedMeta.textContent = `${Math.round(file.size / 1024)} KB`;
  fileToDataUrl(file).then((url) => {
    els.sourcePreview.src = url;
  });
  generateCanvasOutput(file, true).catch(() => {});
}

function showOutput(item) {
  els.selectedTitle.textContent = item.name;
  els.selectedMeta.textContent = `${item.width} x ${item.height}`;
  els.sourcePreview.src = item.sourceUrl;
  els.aiPreview.src = item.outputUrl;
  els.aiPreview.hidden = false;
  els.previewCanvas.hidden = true;
}

function renderResults() {
  els.results.innerHTML = "";
  els.downloadAllBtn.disabled = state.outputs.length === 0;

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

async function generateBatch() {
  try {
    if (!state.files.length) throw new Error("Upload at least one source image.");

    setStatus(`Generating ${state.files.length} canvas image(s)...`);
    state.outputs = [];
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
    "Follow the exact 400x533 coordinate standard from the guide. Game title visual block must be scaled to nearly fill the 360px title safe width. If the title is smaller than 340px wide, enlarge it; if it is wider than 360px, shrink it. Target title width is 350-360px.",
    "Golden composition: place the visual center of the game title block around y=329px on the 400x533 canvas. Acceptable title-center range is y=305-345px. Keep title centered horizontally and highly readable.",
    "Do not add any brand logo, provider logo, watermark, footer plaque, or lower-left mark.",
    "Keep all important source artwork visible: top text, multipliers, upper decorations, edge/corner characters, side creatures, main subject, and full game title.",
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
  if (!response.ok) throw new Error(data.error || "AI generation failed.");

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
  els.imageCount.textContent = state.files.length ? `${state.files.length} image(s) selected` : "No images selected";
  renderResults();
  selectImage(0);
});

for (const input of [els.exportWidth, els.footerRatio]) {
  input.addEventListener("input", () => selectImage(state.selectedIndex));
}

els.canvasBtn.addEventListener("click", expandSelected);
els.batchBtn.addEventListener("click", generateBatch);
els.aiBtn.addEventListener("click", generateAiSelected);
els.aiBatchBtn.addEventListener("click", generateAiBatch);
els.downloadAllBtn.addEventListener("click", downloadOutputsZip);
