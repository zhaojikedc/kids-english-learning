"use strict";

const {
  clampSettings,
  accessGranted,
  newTaskId,
  safeTaskId,
  BODY_LIMIT
} = require("./core");
const { runOcrJob } = require("./ocr");

function ok(json) { return { status: 200, json: json }; }
function fail(status, error) { return { status: status, json: { error: error } }; }

async function requireAccess(ctx) {
  if (!ctx.isPublic) return null;
  const expected = ctx.accessCode || await ctx.store.getOrCreateAccessCode();
  const provided = ctx.header("x-access-code");
  if (await accessGranted(provided, expected)) return null;
  return fail(401, "需要访问码");
}

async function settleOcr(ctx, id, images, paths) {
  try {
    await runOcrJob({
      id: id,
      images: images,
      paths: paths,
      store: ctx.store,
      complete: ctx.complete,
      ocrModel: ctx.ocrModel
    });
  } catch (err) {
    console.error(JSON.stringify({
      message: "ocr failed",
      error: err instanceof Error ? err.message : String(err)
    }));
    try {
      await ctx.store.putOcr(id, { status: "error", cards: [], error: "识别失败", at: Date.now() });
    } catch (writeErr) { /* 状态写不回去也只能结束 */ }
  }
}

async function handleApi(ctx) {
  const path = ctx.pathname;
  const method = ctx.method;

  if (path.indexOf("/api/") !== 0) return null;

  if (path === "/api/health") {
    return ok({ ok: true, model: ctx.model, hasKey: !!ctx.apiKey });
  }

  try {
    const denied = await requireAccess(ctx);
    if (denied) return denied;

    if (path === "/api/chat" && method === "POST") return await handleChat(ctx);
    if (path === "/api/ocr-cards" && method === "POST") return await handleOcrStart(ctx);
    if (path.indexOf("/api/ocr-cards/") === 0 && method === "GET") {
      return await handleOcrGet(ctx, path.slice("/api/ocr-cards/".length));
    }
    if (path === "/api/cards" && method === "GET") return ok({ cards: await ctx.store.getCards() });
    if (path === "/api/cards" && method === "POST") return await handleCardsPost(ctx);
    if (path === "/api/chatlog" && method === "GET") return ok({ chat: await ctx.store.getChat() });
    if (path === "/api/chatlog" && method === "POST") return await handleChatlogPost(ctx);
    if (path === "/api/profile" && method === "GET") return ok(await ctx.store.getProfile());
    if (path === "/api/profile" && method === "POST") return await handleProfilePost(ctx);
    if (path === "/api/logs" && method === "GET") return ok({ logs: await ctx.store.getLogs() });
    if (path === "/api/logs" && method === "POST") return await handleLogsPost(ctx);
    if (path === "/api/reports" && method === "GET") return ok({ reports: await ctx.store.getReports() });
    if (path === "/api/reports" && method === "POST") return await handleReportsPost(ctx);
    if (path === "/api/settings" && method === "GET") return ok(await ctx.store.getSettings());
    if (path === "/api/settings" && method === "POST") return await handleSettingsPost(ctx);
    if (path === "/api/tunnel" && method === "GET") return ok({ url: await ctx.store.getTunnelUrl() });
    if (path === "/api/reset" && method === "GET") return ok(await ctx.store.getReset());
    if (path === "/api/access" && method === "GET") return await handleAccessGet(ctx);
  } catch (err) {
    console.error(JSON.stringify({
      message: "api failed",
      path: path,
      error: err instanceof Error ? err.message : String(err)
    }));
    const writing = method === "POST";
    return fail(500, writing ? "保存失败" : "读取失败");
  }

  return null;
}

async function readPayload(ctx) {
  const read = await ctx.readJson();
  if (!read.ok) return { error: fail(read.status || 400, read.error || "请求格式不对") };
  return { value: read.value };
}

async function handleChat(ctx) {
  if (!ctx.apiKey) return fail(500, "没有找到 DEEPSEEK_API_KEY，请先配置");
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const body = payload.value || {};
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (!messages.length) return fail(400, "messages 为空");
  const result = await ctx.complete({
    model: body.model || ctx.model,
    messages: messages,
    max_tokens: Math.min(Number(body.max_tokens) || 900, 2400),
    temperature: typeof body.temperature === "number" ? body.temperature : 0.6,
    stream: false
  }, 240000);
  if (!result.ok) return fail(result.status || 502, result.error || "上游错误");
  return ok({ content: result.content || "", reasoning: result.reasoning || "", usage: result.usage || null });
}

async function handleOcrStart(ctx) {
  if (!ctx.apiKey) return fail(500, "没有找到 DEEPSEEK_API_KEY");
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const body = payload.value || {};
  let images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  images = images.filter((u) => typeof u === "string" && u.indexOf("data:image/") === 0);
  if (!images.length) return fail(400, "没有收到图片");

  await ctx.store.cleanupOcr(30 * 60 * 1000);
  const id = newTaskId();
  const paths = await ctx.store.saveImages(id, images);
  await ctx.store.putOcr(id, { status: "running", cards: [], error: "", at: Date.now() });
  const job = settleOcr(ctx, id, images, paths);
  if (ctx.ocrInline) {
    await job;
  } else if (typeof ctx.schedule === "function") {
    ctx.schedule(job);
  } else {
    job.catch((err) => {
      console.error(JSON.stringify({
        message: "ocr schedule failed",
        error: err instanceof Error ? err.message : String(err)
      }));
    });
  }
  return ok({ id: id });
}

async function handleOcrGet(ctx, rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch (e) { return fail(404, "任务不存在或已过期"); }
  if (!safeTaskId(id)) return fail(404, "任务不存在或已过期");
  const task = await ctx.store.getOcr(id);
  if (!task) return fail(404, "任务不存在或已过期");
  return ok({ status: task.status, cards: task.cards || [], error: task.error || "" });
}

async function handleCardsPost(ctx) {
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const body = payload.value || {};
  if (!Array.isArray(body.cards)) return fail(400, "cards 必须是数组");
  const cards = body.cards.slice(0, 5000);
  await ctx.store.putCards(cards);
  return ok({ ok: true, count: cards.length });
}

async function handleChatlogPost(ctx) {
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const body = payload.value || {};
  if (!Array.isArray(body.chat)) return fail(400, "chat 必须是数组");
  const chat = body.chat.slice(-60);
  await ctx.store.putChat(chat);
  return ok({ ok: true, count: Math.min(body.chat.length, 60) });
}

async function handleProfilePost(ctx) {
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const body = payload.value || {};
  const summary = String(body.summary || "").slice(0, 2000);
  const profile = { updated: new Date().toISOString(), summary: summary };
  await ctx.store.putProfile(profile);
  return ok({ ok: true });
}

async function handleLogsPost(ctx) {
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const body = payload.value || {};
  if (!Array.isArray(body.logs)) return fail(400, "logs 必须是数组");
  const logs = body.logs.slice(-2000);
  await ctx.store.putLogs(logs);
  return ok({ ok: true, count: Math.min(body.logs.length, 2000) });
}

async function handleReportsPost(ctx) {
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const body = payload.value || {};
  const week = String(body.week || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return fail(400, "week 格式不对");

  let tasks = [];
  if (Array.isArray(body.tasks)) {
    tasks = body.tasks.slice(0, 20).map((t) => ({
      title: String((t && t.title) || "").slice(0, 200),
      type: String((t && t.type) || "").slice(0, 20),
      done: !!(t && t.done)
    }));
  }
  const entry = {
    week: week,
    text: String(body.text || "").slice(0, 4000),
    tasks: tasks,
    updated: new Date().toISOString()
  };
  const list = await ctx.store.getReports();
  let idx = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].week === week) { idx = i; break; }
  }
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  list.sort((a, b) => a.week < b.week ? 1 : -1);
  await ctx.store.putReports(list);
  await ctx.store.saveWeekly(entry);
  return ok({ ok: true });
}

async function handleSettingsPost(ctx) {
  const payload = await readPayload(ctx);
  if (payload.error) return payload.error;
  const settings = clampSettings(payload.value || {});
  await ctx.store.putSettings(settings);
  return ok({ ok: true, dailyGoal: settings.dailyGoal, typeGoals: settings.typeGoals });
}

async function handleAccessGet(ctx) {
  if (ctx.isPublic) return fail(403, "本机才能查看访问码");
  const code = ctx.accessCode || await ctx.store.getOrCreateAccessCode();
  return ok({ code: code });
}

module.exports = { handleApi, BODY_LIMIT };
