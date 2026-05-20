# Brand Image Agent

An online agent for turning brand/game art into portrait marketing images like the Figma reference:

- upload one brand logo
- upload a batch of source images
- generate 400:533 portrait-style outputs with a preserved hero area, extended footer, and logo placement
- optionally call OpenAI image generation for AI-enhanced background extension

## Local preview

The deterministic canvas generator works without dependencies:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/public/`.

## Local batch worker for hundreds of images

For 600+ images, use the local worker instead of keeping a browser tab alive. It processes a folder one image at a time, writes completed covers to disk, and saves `_manifest.json` so it can resume after interruption.

Install dependencies once:

```bash
npm install
```

Run a batch:

```bash
OPENAI_API_KEY=sk-... npm run batch:local -- \
  --input "/path/to/source-images" \
  --logo "/path/to/logo.png" \
  --output "/path/to/output-folder" \
  --quality medium \
  --concurrency 1
```

Useful options:

- `--quality low` for cheaper drafts, `medium` for normal batches, `high` for final selected covers.
- `--concurrency 1` is safest. Use `2` only if rate limits are healthy.
- `--retry-failed` retries only files marked failed in `_manifest.json`.
- `--dry-run` lists images without calling OpenAI.

Outputs are final `400x533` PNG files named like `GameName-ai-portrait.png`.

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
