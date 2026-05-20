const MAX_DATA_URL_LENGTH = 12 * 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_DATA_URL_LENGTH * 2) {
        reject(new Error("Payload too large. Try a smaller image or use the canvas generator."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function assertDataUrl(value, label) {
  if (typeof value !== "string" || !value.startsWith("data:image/")) {
    throw new Error(`${label} must be an image data URL.`);
  }
  if (value.length > MAX_DATA_URL_LENGTH) {
    throw new Error(`${label} is too large. Compress it and try again.`);
  }
}

function buildPrompt({ brandName, instructions }) {
  const brandLine = brandName ? `Brand name: ${brandName}.` : "Brand name is unknown.";
  const customLine = instructions ? `Additional direction: ${instructions}` : "";

  return [
    "Create a premium portrait marketing image from the first reference image.",
    brandLine,
    "Use the second reference image as the brand logo.",
    "Match this production pattern: preserve the main subject, product/game title, colors, and lighting from the source image; recompose into a vertical portrait asset; extend the lower area into a dark, smooth branded footer; place the logo centered in the lower footer.",
    "Keep all existing title text readable and unchanged. Preserve the logo as accurately as possible. Do not invent extra text, badges, UI, watermarks, or borders.",
    "Make the final feel like a polished app-store or casino game promotional creative.",
    customLine
  ]
    .filter(Boolean)
    .join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(501).json({
        error: "OPENAI_API_KEY is not configured. Use the canvas generator or add the key in your host."
      });
      return;
    }

    const payload = await readJson(req);
    assertDataUrl(payload.sourceImage, "sourceImage");
    assertDataUrl(payload.logoImage, "logoImage");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TEXT_MODEL || "gpt-5.2",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildPrompt({
                  brandName: payload.brandName,
                  instructions: payload.instructions
                })
              },
              {
                type: "input_image",
                image_url: payload.sourceImage
              },
              {
                type: "input_image",
                image_url: payload.logoImage
              }
            ]
          }
        ],
        tools: [
          {
            type: "image_generation",
            size: "1024x1536",
            quality: payload.quality || "medium",
            action: "edit"
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({
        error: data.error?.message || "OpenAI request failed",
        detail: data
      });
      return;
    }

    const imageCall = data.output?.find((item) => item.type === "image_generation_call");
    if (!imageCall?.result) {
      res.status(502).json({
        error: "OpenAI did not return an image_generation_call result.",
        detail: data
      });
      return;
    }

    res.status(200).json({
      image: `data:image/png;base64,${imageCall.result}`,
      revisedPrompt: imageCall.revised_prompt || null
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Invalid request" });
  }
}
