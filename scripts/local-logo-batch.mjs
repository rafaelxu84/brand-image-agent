#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const DESIGN = { width: 400, height: 533 };
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function parseArgs(argv) {
  const args = {
    input: "",
    output: "logo-output",
    logo: "",
    x: 40,
    y: 430,
    width: 160,
    opacity: 1,
    force: false,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      if (["x", "y", "width", "opacity"].includes(key)) args[key] = Number(value);
      else args[key] = value;
    }
  }

  return args;
}

function usage() {
  return `
Local logo batch composer

Usage:
  npm run logo:local -- \\
    --input /path/to/covers \\
    --output /path/to/logo-output \\
    --logo /path/to/logo.png \\
    --x 40 --y 430 --width 160 --opacity 1

Options:
  --force      Regenerate completed files too
  --dry-run    List images without writing output
`.trim();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeBaseName(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "cover";
}

async function listImages(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function readManifest(manifestPath) {
  if (!(await pathExists(manifestPath))) return { files: {}, createdAt: new Date().toISOString() };
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

async function writeManifest(manifestPath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function logoBufferFor(args) {
  const logo = sharp(args.logo).rotate();
  const metadata = await logo.metadata();
  const width = Math.max(1, Math.round(args.width || metadata.width || 160));
  const resized = await sharp(args.logo)
    .rotate()
    .resize({ width, withoutEnlargement: false })
    .ensureAlpha()
    .png()
    .toBuffer();

  const opacity = Math.max(0, Math.min(1, Number(args.opacity) || 1));
  if (opacity >= 0.999) return resized;

  const raw = await sharp(resized).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 3; index < raw.data.length; index += 4) {
    raw.data[index] = Math.round(raw.data[index] * opacity);
  }
  return sharp(raw.data, { raw: raw.info }).png().toBuffer();
}

async function processOne({ filePath, args, logoBuffer, manifest, manifestPath }) {
  const key = path.basename(filePath);
  const outputPath = path.join(args.output, `${safeBaseName(filePath)}-logo.png`);
  const record = manifest.files[key] || {};

  if (record.status === "completed" && !args.force && (await pathExists(outputPath))) {
    console.log(`skip completed: ${key}`);
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
    console.log(`logo: ${key}`);
    await sharp(filePath)
      .rotate()
      .resize(DESIGN.width, DESIGN.height, { fit: "fill" })
      .composite([
        {
          input: logoBuffer,
          left: Math.round(Number(args.x) || 0),
          top: Math.round(Number(args.y) || 0)
        }
      ])
      .png()
      .toFile(outputPath);

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
  if (args.help || !args.input || !args.output || !args.logo) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  args.input = path.resolve(args.input);
  args.output = path.resolve(args.output);
  args.logo = path.resolve(args.logo);
  args.x = Number(args.x) || 0;
  args.y = Number(args.y) || 0;
  args.width = Math.max(1, Number(args.width) || 160);
  args.opacity = Math.max(0, Math.min(1, Number(args.opacity) || 1));

  await fs.mkdir(args.output, { recursive: true });
  const manifestPath = path.join(args.output, "_logo_manifest.json");
  const manifest = await readManifest(manifestPath);
  const files = await listImages(args.input);

  console.log(`found ${files.length} image(s)`);
  console.log(`output: ${args.output}`);
  console.log(`logo: ${args.logo}`);
  console.log(`placement: x=${args.x}, y=${args.y}, width=${args.width}, opacity=${args.opacity}`);

  if (args.dryRun) {
    for (const file of files) console.log(file);
    return;
  }

  const logoBuffer = await logoBufferFor(args);
  for (const filePath of files) {
    await processOne({ filePath, args, logoBuffer, manifest, manifestPath });
  }

  const records = Object.values(manifest.files);
  const completed = records.filter((item) => item.status === "completed").length;
  const failed = records.filter((item) => item.status === "failed").length;
  console.log(`logo batch complete. completed=${completed}, failed=${failed}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
