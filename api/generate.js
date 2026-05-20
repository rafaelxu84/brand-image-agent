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
    "Use the second reference image as the brand logo.",
    "If a third reference image is provided, treat it as the composition guide: preserve its portrait framing, protected full-artwork placement, lower dark occlusion/gradient area, and fixed lower-left logo position, but make the final more natural and polished than a simple canvas crop.",
    "Exact output layout standard: final visual should be based on a 400px wide by 533px high canvas. The game title block must be centered and scaled to nearly fill the 360px safe width. If the title is smaller than 340px wide, enlarge it; if it is wider than 360px, shrink it. Target title width is 350-360px, with crisp readable lettering. The bottom of the game title should sit at y=413px, which is 120px above the canvas bottom. The bottom logo zone is the bottom 116px of the canvas.",
    "Logo placement standard: left edge x=40px on a 400px canvas, maximum logo width 230px, preserve aspect ratio, and vertically center the logo within the bottom 116px zone. For the actual 1024x1536 output, scale this placement proportionally and keep the same visual alignment.",
    "Hard rule: do not crop, trim, zoom into, or cut off important original source information. Keep the entire original game title, top multipliers, top decorations, corner characters, side creatures, hero subject, and readable text visible. If the source image does not fit the portrait frame, zoom it out and extend/rebuild the surrounding background instead of cropping it.",
    "Critical composition: keep the source image's core information visible. The main character, game title, important symbols, and readable title text must remain exposed. The title should be large, low, centered, and prominent, without being covered by the lower overlay.",
    "Create a vertical cover with a cinematic lower obstruction: the lower 20-28% should have a dark, smoky, soft-gradient mask that covers busy background details but does not hide the game title. The mask should feel integrated with the source lighting and color palette.",
    "Preserve the original title text exactly as much as possible. Do not invent new words, badges, buttons, UI, jackpots, app-store labels, watermarks, or borders.",
    "Place the logo in the lower-left fixed area, matching the guide image placement: left edge about 7-10% from the left, top edge around 81-84% of the final image height, with clear bottom breathing room. Preserve the logo shape and colors accurately.",
    "Make the final suitable as an iGaming game cover: sharp, premium, high contrast, readable, dramatic, and commercially polished.",
    customLine
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeQuality(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
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
    assertDataUrl(payload.logoImage, "logoImage");
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
      },
      {
        type: "input_image",
        image_url: payload.logoImage
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
