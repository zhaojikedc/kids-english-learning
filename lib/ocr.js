"use strict";

const { OCR_EXTRACT_PROMPT, OCR_CARD_PROMPT, parseCards } = require("./core");

async function callModel(complete, model, content, maxTokens) {
  try {
    const result = await complete({
      model: model,
      messages: [{ role: "user", content: content }],
      max_tokens: maxTokens,
      temperature: 0.1
    }, 600000);
    if (!result.ok) return "";
    return String(result.content || "");
  } catch (err) {
    console.error(JSON.stringify({
      message: "ocr model call failed",
      error: err instanceof Error ? err.message : String(err)
    }));
    return "";
  }
}

async function extractBatch(complete, model, images) {
  const content = [{ type: "text", text: OCR_EXTRACT_PROMPT }];
  images.forEach((url, i) => {
    content.push({ type: "text", text: "第 " + (i + 1) + " 张图片：" });
    content.push({ type: "image_url", image_url: { url: url } });
  });
  return callModel(complete, model, content, 6000);
}

async function runOcrJob({ id, images, paths, store, complete, ocrModel }) {
  const batches = [];
  for (let i = 0; i < images.length; i += 3) {
    batches.push(images.slice(i, i + 3));
  }

  const texts = [];
  for (let b = 0; b < batches.length; b++) {
    const text = await extractBatch(complete, ocrModel, batches[b]);
    if (text) texts.push("【第 " + (b + 1) + " 批】\n" + text);
  }

  const combined = texts.join("\n\n---\n\n").slice(0, 60000);
  let cards = [];
  if (combined) {
    const content = [{ type: "text", text: OCR_CARD_PROMPT + "\n\n下面是整篇课本内容：\n" + combined }];
    const raw = await callModel(complete, ocrModel, content, 12000);
    cards = parseCards(raw);
    const imagePaths = paths || [];
    cards.forEach((c, idx) => {
      if (!imagePaths.length) return;
      const pos = Math.floor(idx * imagePaths.length / Math.max(cards.length, 1));
      c.image = imagePaths[Math.min(imagePaths.length - 1, pos)];
    });
  }

  const task = {
    status: cards.length ? "done" : "error",
    cards: cards,
    error: "",
    at: Date.now()
  };
  if (!cards.length) {
    task.error = combined ? "内容提取到了，但没生成有效卡片，再试一次" : "这批图没认出内容，检查图片是否清楚";
  }
  await store.putOcr(id, task);
  return task;
}

module.exports = { runOcrJob };
