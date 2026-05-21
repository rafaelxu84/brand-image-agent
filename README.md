# Brand Image Agent

An online agent for turning brand/game art into portrait marketing images like the Figma reference:

- upload a batch of source images
- generate 400:533 portrait-style outputs with preserved hero/title information and a golden-ratio title position
- optionally call OpenAI image generation for AI-enhanced background extension

## Local preview

The deterministic canvas generator works without dependencies:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/public/`.

## Local batch worker for hundreds of images

For 600+ images, use the local GUI/worker instead of keeping the online browser tab alive. It has two modes:

- `OpenAI Batch API`: lower-cost asynchronous jobs. This is best for large folders and writes `_batch_manifest.json`.
- `Live local requests`: one-by-one immediate generation. This writes `_manifest.json`.

Install dependencies once:

```bash
npm install
```

### GUI mode

Start the local control panel:

```bash
npm run batch:gui
```

Open:

```text
http://localhost:4180
```

Fill in the source image folder, logo path, output folder, quality, and optional API key, then click `Start`.

The GUI shows live logs and completed/failed counts. `Stop` safely stops the worker; rerun with `Retry failed only` to retry failures.

For high-volume runs, keep `Processing mode` set to `OpenAI Batch API - lowest cost`. It uploads local image references to OpenAI Files with `purpose=vision`, creates `/v1/responses` batch jobs, waits for completion, and saves final `400x533` PNG files back to the output folder. No Cloudflare, R2, or Vercel Blob account is required for local Batch API mode. The current generation mode does not add brand/provider logos; it only expands and recomposes the source artwork.

### CLI mode

Run a live one-by-one batch:

```bash
OPENAI_API_KEY=sk-... npm run batch:local -- \
  --input "/path/to/source-images" \
  --output "/path/to/output-folder" \
  --quality medium \
  --concurrency 1
```

Useful options:

- `--quality low` for cheaper drafts, `medium` for normal batches, `high` for final selected covers.
- `--concurrency 1` is safest. Use `2` only if rate limits are healthy.
- `--force` regenerates completed files too.
- `--retry-failed` retries only files marked failed in `_manifest.json`.
- `--dry-run` lists images without calling OpenAI.

Outputs are final `400x533` PNG files named like `GameName-ai-portrait.png`.

Run an OpenAI Batch API job:

```bash
OPENAI_API_KEY=sk-... npm run batch:api -- \
  --input "/path/to/source-images" \
  --output "/path/to/output-folder" \
  --quality medium \
  --chunk-size 100
```

Useful Batch API options:

- `--chunk-size 100` splits large folders into manageable OpenAI batch jobs.
- `--no-wait` submits jobs and exits; run the same command later to collect finished results.
- `--force` regenerates completed files too.
- `--retry-failed` resubmits files marked failed/expired/cancelled in `_batch_manifest.json`.
- `--dry-run` lists images without uploading files or creating batches.

## OpenAI setup

For AI generation on Vercel, add:

```bash
OPENAI_API_KEY=...
OPENAI_TEXT_MODEL=gpt-5.2
```

The API uses the Responses API image generation tool with uploaded source image and logo data URLs. The current default output target is `1024x1536`, because GPT Image models support fixed portrait sizes.

## Deploy

### Online demo

GitHub Pages publishes the static canvas generator from `public/`:

https://rafaelxu84.github.io/brand-image-agent/

The AI-enabled Vercel app is available here:

https://brand-image-agent.vercel.app/

### Vercel deployment

```bash
npm i -g vercel
vercel
vercel env add OPENAI_API_KEY
vercel env add OPENAI_TEXT_MODEL
vercel --prod
```

## GitHub

From this folder:

```bash
git init
git add .
git commit -m "Add brand image agent"
gh repo create brand-image-agent --private --source=. --remote=origin --push
```

The AI cover flow sends the source image, logo, and a canvas-generated composition guide to the serverless API. If `OPENAI_API_KEY` is not set in Vercel, use the temporary API key field in the UI for testing. The key is not stored by the browser.
