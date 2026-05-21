#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const DESIGN = {
  width: 400,
  height: 533,
  footerHeight: 116,
  titleMaxWidth: 360,
  titleCenterY: Math.round(533 * 0.618)
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function parseArgs(argv) {
  const args = {
    input: "",
    logo: "",
    output: "batch-output",
    quality: "medium",
    concurrency: 1,
    delayMs: 1500,
    force: false,
    retryFailed: false,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--retry-failed") {
      args.retryFailed = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      if (key === "concurrency" || key === "delay-ms") {
        args[key === "delay-ms" ? "delayMs" : key] = Number(value);
      } else {
        args[key] = value;
      }
    }
  }

  return args;
}

function usage() {
  return `
Local iGaming cover batch worker

Usage:
  OPENAI_API_KEY=sk-... npm run batch:local -- \\
    --input /path/to/source-images \\
    --output /path/to/output-folder \\
    --quality medium

Options:
  --quality low|medium|high    Default: medium
  --concurrency 1              Default: 1, recommended for reliability
  --delay-ms 1500              Pause between requests per worker
  --force                      Regenerate completed files too
  --retry-failed               Retry files previously marked failed
  --dry-run                    List images without calling OpenAI
`.trim();
}

function normalizeQuality(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeBaseName(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "cover";
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listImages(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function imageToDataUrl(filePath, { maxSide = 1280, format = "jpeg", quality = 84 } = {}) {
  const pipeline = sharp(filePath).rotate();
  const metadata = await pipeline.metadata();
  const scale = Math.min(1, maxSide / Math.max(metadata.width || maxSide, metadata.height || maxSide));
  const width = Math.max(1, Math.round((metadata.width || maxSide) * scale));
  const height = Math.max(1, Math.round((metadata.height || maxSide) * scale));
  const buffer = await sharp(filePath)
    .rotate()
    .resize(width, height, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#111111" })
    .toFormat(format, { quality })
    .toBuffer();
  return `data:image/${format === "jpeg" ? "jpeg" : format};base64,${buffer.toString("base64")}`;
}

function gradientSvg() {
  return Buffer.from(`
<svg width="${DESIGN.width}" height="${DESIGN.height}" viewBox="0 0 ${DESIGN.width} ${DESIGN.height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="330" x2="0" y2="${DESIGN.height}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#090909" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#12100b" stop-opacity="0.72"/>
      <stop offset="1" stop-color="#04070c" stop-opacity="0.96"/>
    </linearGradient>
    <radialGradient id="vignette" cx="200" cy="250" r="310" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.30"/>
    </radialGradient>
  </defs>
  <rect x="0" y="330" width="${DESIGN.width}" height="203" fill="url(#fade)"/>
  <rect x="0" y="0" width="${DESIGN.width}" height="${DESIGN.height}" fill="url(#vignette)"/>
</svg>`);
}

async function makeGuide(sourcePath) {
  const sourceMeta = await sharp(sourcePath).rotate().metadata();
  const sourceWidth = sourceMeta.width || DESIGN.width;
  const sourceHeight = sourceMeta.height || DESIGN.height;
  const background = await sharp(sourcePath)
    .rotate()
    .resize(DESIGN.width + 40, DESIGN.height + 40, { fit: "cover" })
    .blur(8)
    .modulate({ saturation: 1.08 })
    .extract({ left: 20, top: 20, width: DESIGN.width, height: DESIGN.height })
    .toBuffer();

  const artTop = 0;
  const artHeight = DESIGN.titleCenterY + 118;
  const artScale = Math.min(DESIGN.width / sourceWidth, artHeight / sourceHeight);
  const artWidth = Math.max(1, Math.round(sourceWidth * artScale));
  const artDrawHeight = Math.max(1, Math.round(sourceHeight * artScale));
  const artLeft = Math.round((DESIGN.width - artWidth) / 2);
  const artTopOffset = Math.round(artTop + (artHeight - artDrawHeight) * 0.56);
  const artwork = await sharp(sourcePath)
    .rotate()
    .resize(artWidth, artDrawHeight, { fit: "fill" })
    .toBuffer();

  const guide = await sharp(background)
    .composite([
      { input: artwork, left: artLeft, top: artTopOffset },
      { input: gradientSvg(), left: 0, top: 0 }
    ])
    .jpeg({ quality: 82 })
    .toBuffer();

  return `data:image/jpeg;base64,${guide.toString("base64")}`;
}

async function resizeFinalImage(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  if (!base64) throw new Error("OpenAI returned invalid image data.");
  const input = Buffer.from(base64, "base64");
  return sharp(input)
    .resize(DESIGN.width, DESIGN.height, { fit: "fill" })
    .png()
    .toBuffer();
}

function buildPrompt({ brandName, instructions }) {
  return [
    "Create a premium iGaming portrait cover image from the first reference image.",
    brandName ? `Brand name: ${brandName}.` : "Brand name is unknown.",
    "Use the second reference image as the exact composition guide.",
    "Do not add any brand logo, provider logo, watermark, badge, UI label, footer plaque, or lower-left brand mark.",
    "Exact output layout standard: final visual is a 400px wide by 533px high canvas. The game title block must be centered and scaled to nearly fill the 360px safe width. If the title is smaller than 340px wide, enlarge it; if wider than 360px, shrink it. Target title width is 350-360px with crisp readable lettering.",
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

async function callOpenAI({ apiKey, model, quality, brandName, instructions, sourceImage, guideImage }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildPrompt({ brandName, instructions }) },
            { type: "input_image", image_url: sourceImage },
            { type: "input_image", image_url: guideImage }
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
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI request failed with ${response.status}`);
  }
  const imageCall = data.output?.find((item) => item.type === "image_generation_call");
  if (!imageCall?.result) throw new Error("OpenAI did not return an image result.");
  return `data:image/png;base64,${imageCall.result}`;
}

async function readManifest(manifestPath) {
  if (!(await pathExists(manifestPath))) return { files: {}, createdAt: new Date().toISOString() };
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

async function writeManifest(manifestPath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function processOne({ filePath, args, apiKey, model, manifest, manifestPath }) {
  const key = path.basename(filePath);
  const record = manifest.files[key] || {};
  const outputPath = path.join(args.output, `${safeBaseName(filePath)}-ai-portrait.png`);

  if (record.status === "completed" && !args.retryFailed && !args.force && (await pathExists(outputPath))) {
    console.log(`skip completed: ${key}`);
    return;
  }
  if (record.status === "failed" && !args.retryFailed) {
    console.log(`skip failed: ${key} (use --retry-failed)`);
    return;
  }

  manifest.files[key] = {
    status: "running",
    source: filePath,
    output: outputPath,
    startedAt: new Date().toISOString()
  };
  await writeManifest(manifestPath, manifest);

  try {
    console.log(`start: ${key}`);
    const [sourceImage, guideImage] = await Promise.all([
      imageToDataUrl(filePath, { maxSide: 1280, format: "jpeg", quality: 84 }),
      makeGuide(filePath)
    ]);
    const generated = await callOpenAI({
      apiKey,
      model,
      quality: normalizeQuality(args.quality),
      brandName: args.brand || "",
      instructions: args.instructions || "",
      sourceImage,
      guideImage
    });
    const finalBuffer = await resizeFinalImage(generated);
    await fs.writeFile(outputPath, finalBuffer);

    manifest.files[key] = {
      status: "completed",
      source: filePath,
      output: outputPath,
      completedAt: new Date().toISOString()
    };
    await writeManifest(manifestPath, manifest);
    console.log(`done: ${key}`);
  } catch (error) {
    manifest.files[key] = {
      status: "failed",
      source: filePath,
      output: outputPath,
      error: error.message,
      failedAt: new Date().toISOString()
    };
    await writeManifest(manifestPath, manifest);
    console.error(`failed: ${key}: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.input) {
    console.log(usage());
    process.exit(1);
  }

  args.quality = normalizeQuality(args.quality);
  args.concurrency = Math.max(1, Math.min(4, Number(args.concurrency) || 1));
  args.delayMs = Math.max(0, Number(args.delayMs) || 0);
  args.input = path.resolve(args.input);
  if (args.logo) args.logo = path.resolve(args.logo);
  args.output = path.resolve(args.output);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !args.dryRun) throw new Error("OPENAI_API_KEY is required.");
  const model = process.env.OPENAI_TEXT_MODEL || "gpt-5.2";

  await fs.mkdir(args.output, { recursive: true });
  const manifestPath = path.join(args.output, "_manifest.json");
  const manifest = await readManifest(manifestPath);
  const files = await listImages(args.input);
  console.log(`found ${files.length} image(s)`);
  console.log(`output: ${args.output}`);
  console.log(`quality: ${args.quality}, concurrency: ${args.concurrency}`);

  if (args.dryRun) {
    for (const file of files) console.log(file);
    return;
  }

  let nextIndex = 0;
  async function worker(workerId) {
    while (nextIndex < files.length) {
      const filePath = files[nextIndex];
      nextIndex += 1;
      await processOne({ filePath, args, apiKey, model, manifest, manifestPath });
      if (args.delayMs) await sleep(args.delayMs + workerId * 150);
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, (_, index) => worker(index)));

  const records = Object.values(manifest.files);
  const completed = records.filter((item) => item.status === "completed").length;
  const failed = records.filter((item) => item.status === "failed").length;
  console.log(`batch complete. completed=${completed}, failed=${failed}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
