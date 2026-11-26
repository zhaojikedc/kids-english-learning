#!/usr/bin/env node
"use strict";

/*
 * 小树英语复习本 · 本地服务
 * 静态文件在 public/，接口与 Cloudflare Worker 共用 lib/route.js。
 * 数据仍写在本机 data/ 和课本图片目录，方便 node server.js 开发。
 * DeepSeek 密钥只从环境变量或本机 ~/.dsh/.credentials.yaml 读取，仓库里不能有密钥。
 * Worker 不会读这个文件。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleApi, BODY_LIMIT } = require("./lib/route");
const { createFsStore } = require("./lib/store-fs");
const { complete } = require("./lib/deepseek");
const { safeImageName } = require("./lib/core");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "::";
const MODEL = process.env.MODEL || "deepseek-flash";
const OCR_MODEL = process.env.OCR_MODEL || "deepseek-chat";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};

function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return String(process.env.DEEPSEEK_API_KEY).trim();
  try {
    const home = process.env.HOME;
    if (!home) return "";
    const txt = fs.readFileSync(path.join(home, ".dsh", ".credentials.yaml"), "utf8");
    const m = txt.match(/DEEPSEEK_API_KEY:\s*([^\s]+)/);
    if (m) return m[1].trim();
  } catch (e) { /* 本机没有这份文件 */ }
  return "";
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        finish({ ok: false, status: 413, error: "请求太大" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) { finish({ ok: true, value: {} }); return; }
      try { finish({ ok: true, value: JSON.parse(text) }); }
      catch (e) { finish({ ok: false, status: 400, error: "请求格式不对" }); }
    });
    req.on("error", () => finish({ ok: false, status: 400, error: "请求格式不对" }));
  });
}

function inside(rootDir, file) {
  const root = path.resolve(rootDir);
  const target = path.resolve(file);
  return target === root || target.startsWith(root + path.sep);
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function headerValue(req, name) {
  const value = req.headers[String(name || "").toLowerCase()];
  if (Array.isArray(value)) return value.join(",");
  return value == null ? "" : String(value);
}

function requestPath(req) {
  const raw = String(req.url || "/").split("?")[0];
  try { return decodeURIComponent(raw); }
  catch (e) { return raw; }
}

function isPublicRequest(req) {
  return !!(headerValue(req, "cf-connecting-ip") || headerValue(req, "x-forwarded-for"));
}

function createLocalServer(options) {
  const opts = options || {};
  const apiKey = opts.apiKey !== undefined ? String(opts.apiKey || "").trim() : readApiKey();
  const model = opts.model || MODEL;
  const ocrModel = opts.ocrModel || OCR_MODEL;
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const store = opts.store || createFsStore({
    root: opts.root || ROOT,
    imagesDir: opts.imagesDir || path.join(process.env.HOME || "", "Desktop", "个人知识库", "05-课本图片"),
    knowledgeDir: opts.knowledgeDir || path.join(process.env.HOME || "", "Desktop", "个人知识库", "03-项目", "小树英语"),
    tunnelLogs: opts.tunnelLogs
  });

  async function onRequest(req, res) {
    const pathname = requestPath(req);
    if (pathname.indexOf("/images/") === 0) {
      const name = pathname.slice("/images/".length);
      const image = safeImageName(name) ? await store.readImage(name) : null;
      if (!image) {
        res.writeHead(safeImageName(name) ? 404 : 403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(safeImageName(name) ? "not found" : "forbidden");
        return;
      }
      res.writeHead(200, {
        "Content-Type": image.contentType,
        "Cache-Control": "private, max-age=3600"
      });
      res.end(Buffer.from(image.bytes));
      return;
    }

    const result = await handleApi({
      method: req.method,
      pathname: pathname,
      isPublic: isPublicRequest(req),
      accessCode: opts.accessCode ? String(opts.accessCode).trim() : "",
      apiKey: apiKey,
      model: model,
      ocrModel: ocrModel,
      ocrInline: !!opts.ocrInline,
      header: (name) => headerValue(req, name),
      readJson: () => readJson(req),
      store: store,
      complete: opts.complete || ((payload, timeoutMs) => complete(apiKey, payload, timeoutMs))
    });
    if (result) {
      sendJSON(res, result.status, result.json);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    const rel = pathname === "/" ? "/index.html" : pathname;
    const file = path.normalize(path.join(publicDir, rel));
    if (!inside(publicDir, file)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    serveFile(res, file);
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error(JSON.stringify({
        message: "request failed",
        error: err instanceof Error ? err.message : String(err)
      }));
      if (!res.headersSent) sendJSON(res, 500, { error: "服务暂时出错" });
    });
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  return server;
}

if (require.main === module) {
  process.on("uncaughtException", (err) => {
    console.error("[uncaught] " + (err && err.stack ? err.stack : err));
  });
  const apiKey = readApiKey();
  const server = createLocalServer({ apiKey: apiKey });
  server.listen(PORT, HOST, () => {
    console.log("小树英语服务已启动: http://" + HOST + ":" + PORT +
      "  model=" + MODEL + "  key=" + (apiKey ? "已加载" : "缺失"));
  });
}

module.exports = { createLocalServer, readApiKey };
