import { handleApi, BODY_LIMIT } from "../lib/route.js";
import { createD1Store } from "../lib/store-d1.js";
import { complete } from "../lib/deepseek.js";
import { safeImageName } from "../lib/core.js";

function jsonResponse(result) {
  return Response.json(result.json, {
    status: result.status,
    headers: { "Cache-Control": "no-store" }
  });
}

function textResponse(status, message) {
  return new Response(message, {
    status: status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > BODY_LIMIT) return { ok: false, status: 413, error: "请求太大" };
  if (!request.body) return { ok: true, value: {} };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      return { ok: false, status: 413, error: "请求太大" };
    }
    chunks.push(step.value);
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, status: 400, error: "请求格式不对" };
  }
}

function isPublicRequest(request) {
  return !!(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for"));
}

function secretValue(env, name) {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

async function serveImage(bucket, pathname) {
  let name = pathname.slice("/images/".length);
  try { name = decodeURIComponent(name); } catch (e) { name = ""; }
  const safe = safeImageName(name);
  if (!safe) return textResponse(403, "forbidden");
  const obj = await bucket.get("images/" + safe);
  if (!obj) return textResponse(404, "not found");
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=3600"
    }
  });
}

async function handle(request, env) {
  const url = new URL(request.url);
  console.log(JSON.stringify({ message: "request", method: request.method, path: url.pathname }));

  if (url.pathname.indexOf("/images/") === 0) {
    return serveImage(env.BUCKET, url.pathname);
  }

  const apiKey = secretValue(env, "DEEPSEEK_API_KEY");
  const accessCode = secretValue(env, "ACCESS_CODE");
  const result = await handleApi({
    method: request.method,
    pathname: url.pathname,
    isPublic: isPublicRequest(request),
    accessCode: accessCode,
    apiKey: apiKey,
    model: env.MODEL || "deepseek-flash",
    ocrModel: env.OCR_MODEL || "deepseek-chat",
    ocrInline: true,
    header: (name) => request.headers.get(name) || "",
    readJson: () => readJson(request),
    store: createD1Store(env.DB, env.BUCKET),
    complete: (payload, timeoutMs) => complete(apiKey, payload, timeoutMs)
  });

  if (result) return jsonResponse(result);
  if (request.method !== "GET" && request.method !== "HEAD") return textResponse(405, "method not allowed");
  return textResponse(404, "not found");
}

// 识图在这次请求里做完再响应。waitUntil 在响应发出后大约只有 30 秒，不够看完几张课本页。
export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(JSON.stringify({
        message: "request failed",
        error: err instanceof Error ? err.message : String(err)
      }));
      return Response.json({ error: "服务暂时出错" }, {
        status: 500,
        headers: { "Cache-Control": "no-store" }
      });
    }
  }
};
