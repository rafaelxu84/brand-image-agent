const MAX_DATA_URL_LENGTH = 12 * 1024 * 1024;
const MAX_BODY_LENGTH = 38 * 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_LENGTH) {
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
    "Create a premium iGaming portrait cover image from the first reference image.",
    brandLine,
    "If a second reference image is provided, treat it as the composition guide: preserve its portrait framing, protected full-artwork placement, and lower dark occlusion/gradient area, but make the final more natural and polished than a simple canvas crop.",
    "Do not add any brand logo, provider logo, watermark, badge, UI label, footer plaque, or lower-left brand mark. The output should only contain the expanded game artwork and its original game title/content.",
    "Exact output layout standard: final visual should be based on a 400px wide by 533px high canvas. The game title block must be centered and scaled to nearly fill the 360px safe width. If the title is smaller than 340px wide, enlarge it; if it is wider than 360px, shrink it. Target title width is 350-360px, with crisp readable lettering.",
    "Golden composition rule: place the visual center of the game title block on or very near the golden-ratio horizontal line, around y=329px on a 400x533 canvas. Acceptable title-center range is y=305-345px. Keep the title centered horizontally, large, exposed, and readable.",
    "Hard rule: do not crop, trim, zoom into, or cut off important original source information. Keep the entire original game title, top multipliers, top decorations, corner characters, side creatures, hero subject, and readable text visible. If the source image does not fit the portrait frame, zoom it out and extend/rebuild the surrounding background instead of cropping it.",
    "Critical composition: keep the source image's core information visible. The main character, game title, important symbols, and readable title text must remain exposed. The title should be large, centered, and prominent, without being covered by the lower overlay.",
    "Create a vertical cover with a cinematic lower obstruction: the lower 14-22% can have a dark, smoky, soft-gradient mask that covers busy background details but never hides the game title. The mask should feel integrated with the source lighting and color palette.",
    "Preserve the original title text exactly as much as possible. Do not invent new words, badges, buttons, UI, jackpots, app-store labels, watermarks, or borders.",
    "Make the final suitable as an iGaming game cover: sharp, premium, high contrast, readable, dramatic, and commercially polished.",
    customLine
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeQuality(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

function outputSummary(data) {
  return (data?.output || [])
    .map((item) => {
      const text = item.content
        ?.map((part) => part.text || part.refusal || "")
        .filter(Boolean)
        .join(" ")
        .slice(0, 220);
      return [item.type, item.status, text].filter(Boolean).join(": ");
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const payload = await readJson(req);
    const apiKey = process.env.OPENAI_API_KEY || payload.apiKey;
    if (!apiKey) {
      res.status(501).json({
        error: "OPENAI_API_KEY is not configured. Add it in Vercel or enter a temporary API key in the UI."
      });
      return;
    }

    assertDataUrl(payload.sourceImage, "sourceImage");
    if (payload.referenceImage) {
      assertDataUrl(payload.referenceImage, "referenceImage");
    }

    const content = [
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
      }
    ];

    if (payload.referenceImage) {
      content.push({
        type: "input_image",
        image_url: payload.referenceImage
      });
    }

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
            content
          }
        ],
        tools: [
          {
            type: "image_generation",
            size: "1024x1536",
            quality: normalizeQuality(payload.quality),
            action: "edit"
          }
        ],
        tool_choice: { type: "image_generation" }
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
        outputTypes: outputSummary(data),
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
