"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { DatabaseSync } = require("node:sqlite");
const { parseCards } = require("./lib/core");
const { handleApi } = require("./lib/route");
const { createFsStore } = require("./lib/store-fs");
const { createD1Store } = require("./lib/store-d1");
const { createLocalServer } = require("./server");
const { complete } = require("./lib/deepseek");
const { validateWav, transcribe, ASR_URL, ASR_TIMEOUT_MS, WAV_MAX_BYTES } = require("./lib/asr");

let pass = 0;
function ok(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(() => {
      pass++;
      console.log("PASS " + name);
    });
  }
  pass++;
  console.log("PASS " + name);
  return Promise.resolve();
}

function createSqliteD1(db) {
  function statement(sql, params) {
    return {
      _sql: sql,
      _params: params,
      bind(...next) {
        return statement(sql, params.concat(next));
      },
      async first() {
        const row = db.prepare(sql).get(...params);
        return row || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async run() {
        db.prepare(sql).run(...params);
        return { success: true };
      }
    };
  }
  return {
    prepare(sql) { return statement(sql, []); },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        statements.forEach((s) => db.prepare(s._sql).run(...s._params));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return [];
    }
  };
}

function createBucket() {
  const objects = new Map();
  return {
    objects: objects,
    async put(key, body, options) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      objects.set(key, {
        bytes: bytes,
        contentType: options && options.httpMetadata && options.httpMetadata.contentType
      });
    },
    async get(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: obj.bytes,
        httpMetadata: { contentType: obj.contentType },
        async arrayBuffer() { return obj.bytes.buffer; }
      };
    }
  };
}

function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "migrations", "0001_init.sql"), "utf8"));
  return createSqliteD1(db);
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeWav(options) {
  const opts = options || {};
  const sampleRate = opts.sampleRate || 16000;
  const channels = opts.channels || 1;
  const bits = opts.bits == null ? 16 : opts.bits;
  const format = opts.format == null ? 1 : opts.format;
  const seconds = opts.seconds == null ? 0.5 : opts.seconds;
  const samples = Math.max(1, Math.floor(sampleRate * seconds));
  const block = channels * (bits / 8);
  const dataSize = samples * block;
  const extra = opts.extraChunk || Buffer.alloc(0);
  const buffer = Buffer.alloc(44 + extra.length + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(format, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * block, 28);
  buffer.writeUInt16LE(block, 32);
  buffer.writeUInt16LE(bits, 34);
  if (extra.length) extra.copy(buffer, 36);
  const dataAt = 36 + extra.length;
  buffer.write("data", dataAt);
  buffer.writeUInt32LE(dataSize, dataAt + 4);
  return buffer;
}

function junkChunk() {
  const chunk = Buffer.alloc(14);
  chunk.write("JUNK", 0);
  chunk.writeUInt32LE(5, 4);
  chunk.write("hello", 8);
  return chunk;
}

function ctxFor(store, extra) {
  const options = extra || {};
  return {
    method: options.method || "GET",
    pathname: options.pathname,
    isPublic: !!options.isPublic,
    accessCode: options.accessCode || "",
    apiKey: options.apiKey || "",
    model: "deepseek-flash",
    ocrModel: options.ocrModel || "deepseek-flash",
    ocrInline: options.ocrInline !== false,
    header: (name) => (options.headers && options.headers[String(name).toLowerCase()]) || "",
    readJson: async () => ({ ok: true, value: options.body || {} }),
    readBytes: options.readBytes,
    store: store,
    complete: options.complete || (async () => ({ ok: false, status: 500, content: "", reasoning: "", usage: null, error: "未配置" })),
    transcribe: options.transcribe
  };
}

async function main() {
  await ok("parseCards 能从带说明的文本里抽出卡片", () => {
    const cards = parseCards("好的：\n```json\n[{\"type\":\"单词\",\"unit\":\"U1\",\"question\":\"cat 是什么意思\",\"answer\":\"猫\",\"note\":\"\"}]\n```");
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].type, "单词");
    assert.strictEqual(cards[0].answer, "猫");
  });

  await ok("parseCards 坏掉的输出返回空数组", () => {
    assert.deepStrictEqual(parseCards("没有 json"), []);
  });

  const db = openDb();
  const bucket = createBucket();
  const store = createD1Store(db, bucket);

  await ok("迁移后是空卡片和默认目标，没有虚构课文", async () => {
    const cards = await store.getCards();
    const settings = await store.getSettings();
    const chat = await store.getChat();
    const logs = await store.getLogs();
    const reports = await store.getReports();
    assert.deepStrictEqual(cards, []);
    assert.deepStrictEqual(chat, []);
    assert.deepStrictEqual(logs, []);
    assert.deepStrictEqual(reports, []);
    assert.strictEqual(settings.dailyGoal, 10);
    assert.strictEqual(settings.typeGoals["单词"], 4);
    assert.strictEqual(settings.typeGoals["语法"], 3);
    assert.strictEqual(settings.typeGoals["其他"], 0);
  });

  await ok("D1 卡片整表替换，并丢掉重复 id", async () => {
    await store.putCards([
      { id: "a", question: "cat", answer: "猫", box: 1 },
      { id: "b", question: "dog", answer: "狗", box: 0 },
      { id: "a", question: "cat2", answer: "猫2", box: 2 }
    ]);
    const cards = await store.getCards();
    assert.strictEqual(cards.length, 2);
    assert.strictEqual(cards[0].id, "b");
    assert.strictEqual(cards[1].question, "cat2");
    await store.putCards([{ id: "c", question: "只剩这张", answer: "yes" }]);
    const next = await store.getCards();
    assert.strictEqual(next.length, 1);
    assert.strictEqual(next[0].id, "c");
  });

  await ok("聊天、日志、档案、周总结会写进 D1 和 R2", async () => {
    const saved = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/chatlog",
      body: { chat: [{ role: "user", content: "过去式" }, { role: "assistant", content: "did" }] }
    }));
    assert.strictEqual(saved.json.ok, true);
    const chat = await handleApi(ctxFor(store, { pathname: "/api/chatlog" }));
    assert.strictEqual(chat.json.chat.length, 2);

    await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/logs",
      body: { logs: [{ id: "l1", kind: "review", topic: "cat" }] }
    }));
    const logs = await handleApi(ctxFor(store, { pathname: "/api/logs" }));
    assert.strictEqual(logs.json.logs[0].topic, "cat");

    await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/profile",
      body: { summary: "正在学过去式" }
    }));
    const profile = await handleApi(ctxFor(store, { pathname: "/api/profile" }));
    assert.strictEqual(profile.json.summary, "正在学过去式");

    const bad = await handleApi(ctxFor(store, { method: "POST", pathname: "/api/reports", body: { week: "this-week" } }));
    assert.strictEqual(bad.status, 400);

    const report = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/reports",
      body: { week: "2026-11-16", text: "本周看了过去式", tasks: [{ title: "再练 3 题", type: "语法", done: false }] }
    }));
    assert.strictEqual(report.json.ok, true);
    const listed = await handleApi(ctxFor(store, { pathname: "/api/reports" }));
    assert.strictEqual(listed.json.reports[0].week, "2026-11-16");
    const md = bucket.objects.get("knowledge-base/weekly/周总结-2026-11-16.md");
    assert.ok(md, "周总结应该在 R2");
    assert.ok(new TextDecoder().decode(md.bytes).includes("再练 3 题"));
  });

  await ok("公网请求要访问码，本机才能看到码", async () => {
    const hidden = await handleApi(ctxFor(store, { pathname: "/api/access", isPublic: true }));
    assert.strictEqual(hidden.status, 401);
    const shown = await handleApi(ctxFor(store, { pathname: "/api/access", isPublic: false }));
    assert.strictEqual(shown.status, 200);
    assert.match(shown.json.code, /^\d{6}$/);
    const denied = await handleApi(ctxFor(store, {
      pathname: "/api/cards",
      isPublic: true,
      headers: { "x-access-code": "000000" }
    }));
    assert.strictEqual(denied.status, 401);
    const allowed = await handleApi(ctxFor(store, {
      pathname: "/api/cards",
      isPublic: true,
      headers: { "x-access-code": shown.json.code }
    }));
    assert.strictEqual(allowed.status, 200);
    assert.deepStrictEqual(allowed.json.cards, [{ id: "c", question: "只剩这张", answer: "yes" }]);
    const stillHidden = await handleApi(ctxFor(store, {
      pathname: "/api/access",
      isPublic: true,
      headers: { "x-access-code": shown.json.code }
    }));
    assert.strictEqual(stillHidden.status, 403);
  });

  await ok("设定 ACCESS_CODE 时不把密钥写进数据库", async () => {
    const result = await handleApi(ctxFor(store, {
      pathname: "/api/access",
      isPublic: false,
      accessCode: "family-code"
    }));
    assert.strictEqual(result.json.code, "family-code");
    const stored = await handleApi(ctxFor(store, { pathname: "/api/access", isPublic: false }));
    assert.notStrictEqual(stored.json.code, "family-code");
  });

  await ok("没有密钥时聊天、识图和语音转写会失败", async () => {
    const chat = await handleApi(ctxFor(store, { method: "POST", pathname: "/api/chat", body: { messages: [{ role: "user", content: "hi" }] } }));
    assert.strictEqual(chat.status, 500);
    assert.match(chat.json.error, /DEEPSEEK_API_KEY/);
    const ocr = await handleApi(ctxFor(store, { method: "POST", pathname: "/api/ocr-cards", apiKey: "", body: { images: [PNG] } }));
    assert.strictEqual(ocr.status, 500);
    const speech = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "",
      readBytes: async () => ({ ok: true, value: makeWav() })
    }));
    assert.strictEqual(speech.status, 500);
    assert.match(speech.json.error, /DEEPSEEK_API_KEY/);
  });

  await ok("语音转写成功时只返回文本，并原样把 WAV 交给识别", async () => {
    const wav = makeWav({ extraChunk: junkChunk(), seconds: 0.4 });
    const checked = validateWav(wav);
    assert.strictEqual(checked.ok, true);
    assert.strictEqual(checked.sampleRate, 16000);
    assert.ok(checked.duration > 0.3 && checked.duration < 0.5);
    let seen = null;
    const result = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "test-key",
      readBytes: async () => ({ ok: true, value: wav }),
      transcribe: async (bytes, timeoutMs) => {
        seen = { bytes: Buffer.from(bytes), timeoutMs: timeoutMs };
        return { ok: true, status: 200, text: "  What is the weather like in Shanghai today?  ", error: "" };
      }
    }));
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(Object.keys(result.json), ["text"]);
    assert.strictEqual(result.json.text, "What is the weather like in Shanghai today?");
    assert.strictEqual(seen.timeoutMs, ASR_TIMEOUT_MS);
    assert.ok(seen.bytes.equals(wav));
  });

  await ok("语音转写拒绝空音频、非 WAV 和超限音频，且不会请求上游", async () => {
    let calls = 0;
    const transcribe = async () => {
      calls += 1;
      return { ok: true, status: 200, text: "nope", error: "" };
    };
    const missing = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "test-key",
      readBytes: async () => ({ ok: false, status: 400, error: "没有收到音频" }),
      transcribe: transcribe
    }));
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.json.error, "没有收到音频");

    const empty = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "test-key",
      readBytes: async () => ({ ok: true, value: Buffer.alloc(0) }),
      transcribe: transcribe
    }));
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.json.error, "没有收到音频");

    const webm = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "test-key",
      readBytes: async () => ({ ok: true, value: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]) }),
      transcribe: transcribe
    }));
    assert.strictEqual(webm.status, 400);
    assert.strictEqual(webm.json.error, "音频格式不对");

    const floatWav = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "test-key",
      readBytes: async () => ({ ok: true, value: makeWav({ format: 3, bits: 32 }) }),
      transcribe: transcribe
    }));
    assert.strictEqual(floatWav.status, 400);
    assert.strictEqual(floatWav.json.error, "音频格式不对");

    const tooLong = validateWav(makeWav({ seconds: 121 }));
    assert.strictEqual(tooLong.ok, false);
    assert.match(tooLong.error, /120/);
    const huge = Buffer.alloc(WAV_MAX_BYTES + 1);
    huge.write("RIFF", 0);
    const tooBig = validateWav(huge);
    assert.strictEqual(tooBig.ok, false);
    assert.strictEqual(tooBig.status, 413);
    assert.strictEqual(calls, 0);
  });

  await ok("语音转写把上游错误交给页面，公网请求仍要访问码", async () => {
    const busy = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "test-key",
      readBytes: async () => ({ ok: true, value: makeWav() }),
      transcribe: async () => ({ ok: false, status: 503, text: "", error: "识别服务忙，稍后再试" })
    }));
    assert.strictEqual(busy.status, 503);
    assert.strictEqual(busy.json.error, "识别服务忙，稍后再试");

    const thrown = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      apiKey: "test-key",
      readBytes: async () => ({ ok: true, value: makeWav() }),
      transcribe: async () => { throw new Error("socket hang up"); }
    }));
    assert.strictEqual(thrown.status, 502);
    assert.strictEqual(thrown.json.error, "识别失败");

    const hidden = await handleApi(ctxFor(store, { pathname: "/api/access", isPublic: false }));
    const denied = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      isPublic: true,
      apiKey: "test-key",
      headers: { "x-access-code": "000000" },
      readBytes: async () => ({ ok: true, value: makeWav() }),
      transcribe: async () => ({ ok: true, status: 200, text: "secret", error: "" })
    }));
    assert.strictEqual(denied.status, 401);
    const allowed = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/transcribe",
      isPublic: true,
      apiKey: "test-key",
      headers: { "x-access-code": hidden.json.code },
      readBytes: async () => ({ ok: true, value: makeWav() }),
      transcribe: async () => ({ ok: true, status: 200, text: "a cat", error: "" })
    }));
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(allowed.json.text, "a cat");
  });

  await ok("官方语音接口收到 multipart 文件，并翻译上游错误", async () => {
    const original = global.fetch;
    const wav = makeWav({ seconds: 0.25 });
    try {
      let sent = null;
      global.fetch = async (url, opts) => {
        const file = opts.body.get("file");
        sent = {
          url: url,
          method: opts.method,
          auth: opts.headers.Authorization,
          contentType: opts.headers["Content-Type"] || opts.headers["content-type"] || "",
          language: opts.body.get("language"),
          name: file && file.name,
          bytes: Buffer.from(await file.arrayBuffer())
        };
        return new Response(JSON.stringify({
          request_id: "req_test",
          text: "a cat",
          duration_ms: 250
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      const okResult = await transcribe("test-key", wav, 1000);
      assert.strictEqual(okResult.ok, true);
      assert.strictEqual(okResult.text, "a cat");
      assert.strictEqual(sent.url, ASR_URL);
      assert.strictEqual(sent.method, "POST");
      assert.strictEqual(sent.auth, "Bearer test-key");
      assert.strictEqual(sent.contentType, "");
      assert.strictEqual(sent.language, null);
      assert.strictEqual(sent.name, "speech.wav");
      assert.ok(sent.bytes.equals(wav));

      global.fetch = async () => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
      const busy = await transcribe("test-key", wav, 1000);
      assert.strictEqual(busy.ok, false);
      assert.strictEqual(busy.status, 503);
      assert.strictEqual(busy.error, "识别服务忙，稍后再试");

      global.fetch = async () => new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } });
      const bad = await transcribe("test-key", wav, 1000);
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.status, 502);

      global.fetch = async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      };
      const timed = await transcribe("test-key", wav, 1000);
      assert.strictEqual(timed.ok, false);
      assert.strictEqual(timed.status, 504);
      assert.strictEqual(timed.error, "识别超时");
    } finally {
      global.fetch = original;
    }
  });

  await ok("页面把录音发给转写接口，不再使用浏览器语音识别", () => {
    const app = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const sw = fs.readFileSync(path.join(__dirname, "public", "sw.js"), "utf8");
    assert.ok(!app.includes("SpeechRecognition"));
    assert.ok(!app.includes("webkitSpeechRecognition"));
    assert.ok(app.includes("/api/transcribe"));
    assert.ok(app.includes("audio/wav"));
    assert.ok(app.includes("正在识别"));
    assert.ok(app.includes("麦克风没权限"));
    assert.ok(app.includes("没录到声音"));
    assert.ok(app.includes("没听到说话"));
    assert.ok(app.includes("识别超时"));
    assert.ok(app.includes("识别失败"));
    assert.ok(html.includes("app.js?v=60"));
    assert.ok(html.includes("中英文自动识别"));
    assert.ok(!html.includes("lang-toggle"));
    assert.ok(sw.includes("xiaoshu-english-v56"));
    assert.ok(sw.includes("/app.js?v=60"));
  });

  await ok("聊天和识图请求关掉思考模式，并使用当前官方模型", async () => {
    let chatPayload = null;
    const chat = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/chat",
      apiKey: "test-key",
      body: {
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled" }
      },
      complete: async (payload, timeoutMs) => {
        chatPayload = { payload: payload, timeoutMs: timeoutMs };
        return { ok: true, status: 200, content: "hello", reasoning: "", usage: null, error: "" };
      }
    }));
    assert.strictEqual(chat.status, 200);
    assert.strictEqual(chat.json.content, "hello");
    assert.strictEqual(chatPayload.timeoutMs, 240000);
    assert.strictEqual(chatPayload.payload.model, "deepseek-flash");
    assert.deepStrictEqual(chatPayload.payload.thinking, { type: "disabled" });

    let ocrPayload = null;
    const ocr = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/ocr-cards",
      apiKey: "test-key",
      ocrInline: true,
      body: { images: [PNG] },
      complete: async (payload, timeoutMs) => {
        ocrPayload = { payload: payload, timeoutMs: timeoutMs };
        return { ok: true, status: 200, content: "[]", reasoning: "", usage: null, error: "" };
      }
    }));
    assert.strictEqual(ocr.status, 200);
    assert.strictEqual(ocrPayload.timeoutMs, 600000);
    assert.strictEqual(ocrPayload.payload.model, "deepseek-flash");
    assert.deepStrictEqual(ocrPayload.payload.thinking, { type: "disabled" });
  });

  await ok("发给官方接口的请求也会强制关掉思考模式", async () => {
    const original = global.fetch;
    let sent = null;
    global.fetch = async (url, opts) => {
      sent = { url: url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok", reasoning_content: "hidden" } }],
        usage: { total_tokens: 3 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const result = await complete("test-key", {
        model: "deepseek-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled" }
      }, 1000);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content, "ok");
      assert.strictEqual(sent.url, "https://api.deepseek.com/chat/completions");
      assert.strictEqual(sent.auth, "Bearer test-key");
      assert.strictEqual(sent.body.model, "deepseek-flash");
      assert.deepStrictEqual(sent.body.thinking, { type: "disabled" });
    } finally {
      global.fetch = original;
    }
  });

  await ok("页面聊天等待长于服务端，服务端错误不再说成本机没启动", () => {
    const app = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
    assert.match(app, /var CHAT_WAIT_MS = 250000;/);
    assert.ok(!app.includes("70000"));
    const start = app.indexOf("function isLocalPage()");
    const end = app.indexOf("function cardDigest()");
    assert.ok(start > 0 && end > start);
    function messagesFor(hostname) {
      const sandbox = { location: { hostname: hostname } };
      vm.createContext(sandbox);
      vm.runInContext(app.slice(start, end) + [
        "this.out = {",
        "  abort: chatFailText({ name: 'AbortError' }),",
        "  server: chatFailText({ reachedServer: true, message: '请求超时' }),",
        "  down: chatFailText(new TypeError('Failed to fetch'))",
        "};"
      ].join("\n"), sandbox);
      return sandbox.out;
    }
    const local = messagesFor("127.0.0.1");
    const cloud = messagesFor("kids-english-learning.example.workers.dev");
    const timeoutCopy = "等太久了，可能网络卡了，再试一次。";
    const localCopy = "连不上小老师服务。是不是服务没启动？看看有没有打开「启动小树英语.command」。";
    assert.strictEqual(local.abort, timeoutCopy);
    assert.strictEqual(cloud.abort, timeoutCopy);
    assert.strictEqual(local.server, "请求超时");
    assert.strictEqual(cloud.server, "请求超时");
    assert.strictEqual(local.down, localCopy);
    assert.ok(!cloud.down.includes("启动小树英语.command"));
    assert.match(cloud.down, /检查网络后再试一次/);
  });

  await ok("识图走完会把图片放进 R2，卡片带上图片路径", async () => {
    const result = await handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/ocr-cards",
      apiKey: "test-key",
      ocrInline: true,
      body: { images: [PNG, "not-an-image", PNG] },
      complete: async (payload) => {
        const content = payload.messages[0].content;
        const text = Array.isArray(content) ? content.map((part) => part.text || "").join("\n") : String(content);
        if (text.includes("转写")) {
          return { ok: true, status: 200, content: "第 1 张：cat 猫", reasoning: "", usage: null, error: "" };
        }
        return {
          ok: true,
          status: 200,
          content: "[{\"type\":\"单词\",\"unit\":\"U1\",\"question\":\"cat 是什么意思\",\"answer\":\"猫\",\"note\":\"\"}]",
          reasoning: "",
          usage: null,
          error: ""
        };
      }
    }));
    assert.strictEqual(result.status, 200);
    assert.ok(result.json.id);
    const polled = await handleApi(ctxFor(store, { pathname: "/api/ocr-cards/" + result.json.id }));
    assert.strictEqual(polled.json.status, "done");
    assert.strictEqual(polled.json.cards.length, 1);
    assert.ok(polled.json.cards[0].image.indexOf("/images/") === 0);
    const name = polled.json.cards[0].image.slice("/images/".length);
    assert.ok(bucket.objects.has("images/" + name));
  });

  await ok("后台识图不会挡住提交", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = handleApi(ctxFor(store, {
      method: "POST",
      pathname: "/api/ocr-cards",
      apiKey: "test-key",
      ocrInline: false,
      body: { images: [PNG] },
      complete: async () => {
        await gate;
        return { ok: true, status: 200, content: "[]", reasoning: "", usage: null, error: "" };
      }
    }));
    const posted = await started;
    assert.ok(posted.json.id);
    const running = await handleApi(ctxFor(store, { pathname: "/api/ocr-cards/" + posted.json.id }));
    assert.strictEqual(running.json.status, "running");
    release();
    let status = "running";
    for (let i = 0; i < 20 && status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const again = await handleApi(ctxFor(store, { pathname: "/api/ocr-cards/" + posted.json.id }));
      status = again.json.status;
    }
    assert.strictEqual(status, "error");
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoshu-"));
  const imagesDir = path.join(tmp, "images");
  const knowledgeDir = path.join(tmp, "kb");
  const tunnelLog = path.join(tmp, "tunnel.log");
  fs.writeFileSync(tunnelLog, "noise\nhttps://example.trycloudflare.com\nhttps://later-name.trycloudflare.com\n");
  const server = createLocalServer({
    root: tmp,
    publicDir: path.join(__dirname, "public"),
    imagesDir: imagesDir,
    knowledgeDir: knowledgeDir,
    tunnelLogs: [tunnelLog],
    apiKey: "",
    ocrInline: true
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  try {
    await ok("本地服务能打开页面、空卡片和默认目标", async () => {
      const page = await fetch(base + "/");
      const html = await page.text();
      assert.strictEqual(page.status, 200);
      assert.ok(html.includes("小树英语"));
      assert.ok(html.includes("avatar.svg"));
      const health = await fetch(base + "/api/health");
      const healthJson = await health.json();
      assert.strictEqual(healthJson.ok, true);
      assert.strictEqual(healthJson.hasKey, false);
      const cards = await fetch(base + "/api/cards").then((r) => r.json());
      assert.deepStrictEqual(cards.cards, []);
      const settings = await fetch(base + "/api/settings").then((r) => r.json());
      assert.strictEqual(settings.dailyGoal, 10);
    });

    await ok("本地可以保存卡片，隧道地址只在本机日志里", async () => {
      const posted = await fetch(base + "/api/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [{ id: "local", question: "apple", answer: "苹果" }] })
      });
      assert.strictEqual(posted.status, 200);
      const cards = await fetch(base + "/api/cards").then((r) => r.json());
      assert.strictEqual(cards.cards[0].answer, "苹果");
      const saved = JSON.parse(fs.readFileSync(path.join(tmp, "data", "cards.json"), "utf8"));
      assert.strictEqual(saved.cards[0].id, "local");
      const tunnel = await fetch(base + "/api/tunnel").then((r) => r.json());
      assert.strictEqual(tunnel.url, "https://later-name.trycloudflare.com");
    });

    await ok("经过转发的请求必须带访问码", async () => {
      const codeRes = await fetch(base + "/api/access");
      const codeJson = await codeRes.json();
      const blocked = await fetch(base + "/api/cards", { headers: { "x-forwarded-for": "203.0.113.8" } });
      assert.strictEqual(blocked.status, 401);
      const opened = await fetch(base + "/api/cards", {
        headers: { "x-forwarded-for": "203.0.113.8", "x-access-code": codeJson.code }
      });
      assert.strictEqual(opened.status, 200);
    });

    await ok("周总结写到本机知识库目录，图片路径不能逃出目录", async () => {
      const report = await fetch(base + "/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week: "2026-11-23", text: "本地一周", tasks: [{ title: "读课文", type: "例句" }] })
      });
      assert.strictEqual(report.status, 200);
      const md = fs.readFileSync(path.join(knowledgeDir, "周总结-2026-11-23.md"), "utf8");
      assert.ok(md.includes("读课文"));
      const escaped = await fetch(base + "/images/..%2F..%2Fpackage.json");
      assert.ok(escaped.status === 403 || escaped.status === 404);
      const outside = await new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port: port, path: "/../package.json" }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
      });
      assert.strictEqual(outside, 403);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const speechTmp = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoshu-asr-"));
  let forwarded = null;
  let upstreamMode = "ok";
  const speechServer = createLocalServer({
    root: speechTmp,
    publicDir: path.join(__dirname, "public"),
    imagesDir: path.join(speechTmp, "images"),
    knowledgeDir: path.join(speechTmp, "kb"),
    apiKey: "test-key",
    transcribe: async (bytes, timeoutMs) => {
      forwarded = { bytes: Buffer.from(bytes), timeoutMs: timeoutMs };
      if (upstreamMode === "error") return { ok: false, status: 502, text: "", error: "识别失败" };
      return { ok: true, status: 200, text: "I like apples", error: "" };
    }
  });
  await new Promise((resolve) => speechServer.listen(0, "127.0.0.1", resolve));
  const speechBase = "http://127.0.0.1:" + speechServer.address().port;
  try {
    await ok("本地 HTTP 语音接口：成功、缺音频、格式不对、上游失败", async () => {
      const wav = makeWav({ seconds: 0.3 });
      const okRes = await fetch(speechBase + "/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav
      });
      const okJson = await okRes.json();
      assert.strictEqual(okRes.status, 200);
      assert.strictEqual(okJson.text, "I like apples");
      assert.ok(forwarded.bytes.equals(wav));
      assert.strictEqual(forwarded.timeoutMs, ASR_TIMEOUT_MS);

      forwarded = null;
      const missing = await fetch(speechBase + "/api/transcribe", { method: "POST" });
      const missingJson = await missing.json();
      assert.strictEqual(missing.status, 400);
      assert.strictEqual(missingJson.error, "没有收到音频");
      assert.strictEqual(forwarded, null);

      const invalid = await fetch(speechBase + "/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/webm" },
        body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])
      });
      const invalidJson = await invalid.json();
      assert.strictEqual(invalid.status, 400);
      assert.strictEqual(invalidJson.error, "音频格式不对");
      assert.strictEqual(forwarded, null);

      upstreamMode = "error";
      const failed = await fetch(speechBase + "/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav
      });
      const failedJson = await failed.json();
      assert.strictEqual(failed.status, 502);
      assert.strictEqual(failedJson.error, "识别失败");
    });
  } finally {
    await new Promise((resolve) => speechServer.close(resolve));
    fs.rmSync(speechTmp, { recursive: true, force: true });
  }

  console.log("\n全部通过：" + pass + " 项");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
