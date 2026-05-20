const state = {
  logo: null,
  logoUrl: "",
  files: [],
  selectedIndex: 0,
  outputs: []
};

const els = {
  brandName: document.querySelector("#brandName"),
  logoInput: document.querySelector("#logoInput"),
  imageInput: document.querySelector("#imageInput"),
  logoName: document.querySelector("#logoName"),
  imageCount: document.querySelector("#imageCount"),
  exportWidth: document.querySelector("#exportWidth"),
  footerRatio: document.querySelector("#footerRatio"),
  logoScale: document.querySelector("#logoScale"),
  instructions: document.querySelector("#instructions"),
  canvasBtn: document.querySelector("#canvasBtn"),
  batchBtn: document.querySelector("#batchBtn"),
  aiBtn: document.querySelector("#aiBtn"),
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

if (isStaticDemo) {
  els.aiBtn.disabled = true;
  els.aiBtn.title = "AI cover generation needs the Vercel serverless API.";
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

function getOutputSize() {
  const width = Math.max(400, Math.min(2400, Number(els.exportWidth.value) || 1200));
  return {
    width,
    height: Math.round((width * 533) / 400)
  };
}

async function generateCanvasOutput(file, previewOnly = false) {
  if (!state.logoUrl) throw new Error("Upload a logo first.");

  const [sourceUrl, logoImg] = await Promise.all([
    fileToDataUrl(file),
    loadImage(state.logoUrl)
  ]);
  const sourceImg = await loadImage(sourceUrl);
  const size = previewOnly ? { width: 400, height: 533 } : getOutputSize();
  const footerRatio = Math.max(0.14, Math.min(0.34, Number(els.footerRatio.value) / 100));
  const footerH = Math.round(size.height * footerRatio);
  const canvas = previewOnly ? els.previewCanvas : document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = size.width;
  canvas.height = size.height;

  ctx.clearRect(0, 0, size.width, size.height);

  ctx.save();
  ctx.filter = `blur(${Math.round(size.width * 0.02)}px) saturate(1.12)`;
  drawCover(ctx, sourceImg, -size.width * 0.04, -size.height * 0.04, size.width * 1.08, size.height * 1.08);
  ctx.restore();

  drawHeightFit(ctx, sourceImg, size.width, size.height);

  const fade = ctx.createLinearGradient(0, size.height - footerH * 1.55, 0, size.height);
  fade.addColorStop(0, "rgba(10, 10, 8, 0)");
  fade.addColorStop(0.52, "rgba(20, 15, 10, 0.66)");
  fade.addColorStop(1, "rgba(6, 8, 12, 0.95)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, Math.max(0, size.height - footerH * 1.55), size.width, size.height);

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

  const maxLogoW = size.width * (Number(els.logoScale.value) / 100);
  const maxLogoH = footerH * 0.38;
  const logoScale = Math.min(maxLogoW / logoImg.naturalWidth, maxLogoH / logoImg.naturalHeight);
  const logoW = logoImg.naturalWidth * logoScale;
  const logoH = logoImg.naturalHeight * logoScale;
  const logoX = size.width * 0.1;
  const logoY = size.height - footerH * 0.56;

  ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
  ctx.shadowBlur = size.width * 0.018;
  ctx.shadowOffsetY = size.height * 0.006;
  ctx.drawImage(logoImg, logoX, logoY, logoW, logoH);
  ctx.shadowColor = "transparent";

  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    sourceUrl,
    outputUrl: canvas.toDataURL("image/png", 0.96),
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

async function generateBatch() {
  try {
    if (!state.files.length) throw new Error("Upload at least one source image.");
    if (!state.logoUrl) throw new Error("Upload a logo first.");

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
    if (!state.logoUrl) throw new Error("Upload a logo first.");

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

async function generateAiSelected() {
  try {
    const file = state.files[state.selectedIndex];
    if (!file) throw new Error("Select a source image first.");
    if (!state.logoUrl) throw new Error("Upload a logo first.");

    setStatus("Preparing composition guide for AI...");
    const [sourceImage, referenceOutput] = await Promise.all([
      fileToDataUrl(file),
      generateCanvasOutput(file)
    ]);
    const guideText = [
      "Use the third reference image as the exact cover layout guide.",
      "Keep the important source artwork visible, especially the game title and hero subject.",
      "Improve the lower mask so it feels like natural smoke, shadow, or lighting from the original image."
    ].join(" ");

    setStatus("Generating AI iGaming cover...");
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        brandName: els.brandName.value.trim(),
        instructions: [guideText, els.instructions.value.trim()].filter(Boolean).join("\n"),
        sourceImage,
        logoImage: state.logoUrl,
        referenceImage: referenceOutput.outputUrl,
        quality: "high"
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI generation failed.");

    els.aiPreview.src = data.image;
    els.aiPreview.hidden = false;
    els.previewCanvas.hidden = true;
    state.outputs.unshift({
      name: `${file.name.replace(/\.[^.]+$/, "")}-ai`,
      sourceUrl: sourceImage,
      outputUrl: data.image,
      width: 1024,
      height: 1536
    });
    renderResults();
    showOutput(state.outputs[0]);
    setStatus(data.revisedPrompt ? "AI image ready with revised prompt." : "AI image ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

els.logoInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  state.logo = file || null;
  state.logoUrl = file ? await fileToDataUrl(file) : "";
  els.logoName.textContent = file ? file.name : "No logo selected";
  selectImage(state.selectedIndex);
});

els.imageInput.addEventListener("change", (event) => {
  state.files = Array.from(event.target.files || []);
  state.outputs = [];
  els.imageCount.textContent = state.files.length ? `${state.files.length} image(s) selected` : "No images selected";
  renderResults();
  selectImage(0);
});

for (const input of [els.exportWidth, els.footerRatio, els.logoScale]) {
  input.addEventListener("input", () => selectImage(state.selectedIndex));
}

els.canvasBtn.addEventListener("click", expandSelected);
els.batchBtn.addEventListener("click", generateBatch);
els.aiBtn.addEventListener("click", generateAiSelected);
els.downloadAllBtn.addEventListener("click", () => {
  state.outputs.forEach((item) => downloadImage(item.outputUrl, `${item.name}-portrait.png`));
});
