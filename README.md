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

## OpenAI setup

For AI generation on Vercel, add:

```bash
OPENAI_API_KEY=...
OPENAI_TEXT_MODEL=gpt-5.2
```

The API uses the Responses API image generation tool with uploaded source image and logo data URLs. The current default output target is `1024x1536`, because GPT Image models support fixed portrait sizes.

## Deploy

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
