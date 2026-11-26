"use strict";

const DEFAULT_TYPE_GOALS = { "单词": 4, "语法": 3, "例句": 3, "其他": 0 };

const OCR_EXTRACT_PROMPT = [
  "你是英语老师。请把图片里的课本内容完整、忠实地转写出来，不要出题，不要总结。",
  "要保留：单元标题、课文或对话原文、单词表、语法讲解、练习题。",
  "按顺序分段写，每段标明来自第几张图。看不清的词用 [不清] 标出，不要编。",
  "只输出转写内容，不要任何解释。"
].join("\n");

const OCR_CARD_PROMPT = [
  "你是英语老师，帮三年级学生小树（剑桥少儿英语二级 Movers）整理课本。",
  "下面是一张或多张课本页图片。先判断每张图是什么类型，再按类型出卡片。",
  "只输出 JSON 数组，不要任何解释、不要 Markdown 代码块。每个元素格式：",
  '{"type":"单词|语法|例句|其他","unit":"单元或页码，看不清就留空","question":"中文提问或英文单词","answer":"答案、解释或英文句子","note":"一句话小提示，没有就留空"}',
  "按图片类型处理：",
  "1. 单词表：做成单词卡，英文对中文，一个词一张。",
  "2. 语法讲解页：提炼语法点，做成中文问答题；页面上如果有单词表或词汇框，也一并做成单词卡。",
  "3. 课文或对话：绝对不要逐词拆开！按整篇出理解题：问大意、问人物、问细节，用中文提问；另外加一张「读一读这段对话/课文」的跟读卡，答案放整段原文。整页最多 8 张。",
  "4. 练习题：保留原来的题目和答案。",
  "通用规则：",
  "- 每张图生成 3 到 10 张卡片，宁可少而精，不要为凑数把整页拆碎。",
  "- 只有单词表才做单词卡；课文里出现的生词最多挑 3 个最关键的。",
  "- 英文例句和课文原文要原样保留，不要改写。",
  "- question 必须写清楚要孩子做什么，三年级孩子一看就懂，比如「请写出 live 的过去式」「请把『我昨天去了公园』翻译成英文」「写出这个词的中文意思」，不要只写「过去式」这种没头没尾的。",
  "- question 和 answer 必须对应同一个知识点：问中文意思，answer 就写中文意思；问过去式，answer 就写过去式；绝对不要把题和答案配错。",
  "- answer 要短，控制在 60 字以内，只写最关键的一两句，不要把整段课文塞进答案。",
  "- 答案里中英文分开：中文解释用中文，英文例句用英文，不要混在同一句里。",
  "- 课文原文单独做成一张跟读卡：type 用「其他」，question 写「读一读 Unit X 的课文」，answer 只放原文，note 标注「课文原文」。",
  "- 多张图片合并成一个数组，不要重复。",
  "- 主要识别印刷体；手写内容看得清就整理，看不清就直接跳过，不要猜。",
  "- 只整理图片里真实存在的内容，看不清的词不要编。",
  "- type 只能是 单词、语法、例句、其他；课文理解题用「其他」。"
].join("\n");

const BODY_LIMIT = 12 * 1024 * 1024;

function normalizeSettings(d) {
  const src = d && typeof d === "object" ? d : {};
  const tg = src.typeGoals && typeof src.typeGoals === "object" ? src.typeGoals : null;
  function pick(k) {
    if (tg && tg[k] !== undefined && tg[k] !== null) return Math.max(0, Number(tg[k]) || 0);
    return DEFAULT_TYPE_GOALS[k];
  }
  return {
    dailyGoal: typeof src.dailyGoal === "number" ? src.dailyGoal : 10,
    typeGoals: {
      "单词": pick("单词"),
      "语法": pick("语法"),
      "例句": pick("例句"),
      "其他": pick("其他")
    }
  };
}

function clampSettings(body) {
  const src = body && typeof body === "object" ? body : {};
  const tg = src.typeGoals && typeof src.typeGoals === "object" ? src.typeGoals : {};
  return {
    dailyGoal: Math.max(1, Math.min(100, Number(src.dailyGoal) || 10)),
    typeGoals: {
      "单词": Math.max(0, Math.min(50, Number(tg["单词"]) || 0)),
      "语法": Math.max(0, Math.min(50, Number(tg["语法"]) || 0)),
      "例句": Math.max(0, Math.min(50, Number(tg["例句"]) || 0)),
      "其他": Math.max(0, Math.min(50, Number(tg["其他"]) || 0))
    }
  };
}

function parseCards(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  let arr = null;
  try { arr = JSON.parse(s); } catch (e) { arr = null; }

  if (!Array.isArray(arr) && start >= 0) {
    const lastBrace = s.lastIndexOf("}");
    if (lastBrace > start) {
      try { arr = JSON.parse(s.slice(0, lastBrace + 1) + "]"); } catch (e2) { arr = null; }
    }
  }

  if (!Array.isArray(arr)) {
    const objs = s.match(/\{[^{}]*\}/g) || [];
    arr = [];
    objs.forEach((o) => {
      try { arr.push(JSON.parse(o)); } catch (e3) { /* skip broken object */ }
    });
  }

  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.forEach((c) => {
    if (!c || !c.question || !c.answer) return;
    let type = String(c.type || "其他");
    if (["单词", "语法", "例句", "其他"].indexOf(type) < 0) type = "其他";
    out.push({
      type: type,
      unit: String(c.unit || "").trim().slice(0, 40),
      question: String(c.question).trim().slice(0, 300),
      answer: String(c.answer).trim().slice(0, 600),
      note: String(c.note || "").trim().slice(0, 200)
    });
  });
  return out;
}

function safeImageName(name) {
  const s = String(name || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s)) return "";
  if (s.indexOf("..") >= 0) return "";
  return s;
}

function safeTaskId(id) {
  const s = String(id || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) return "";
  return s;
}

function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  const subtype = m[1].toLowerCase();
  const ext = subtype === "png" ? "png" : "jpg";
  const contentType = ext === "png" ? "image/png" : "image/jpeg";
  const b64 = m[2].replace(/\s/g, "");
  let bytes;
  if (typeof Buffer !== "undefined") {
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  } else {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  if (!bytes.length) return null;
  return { ext, contentType, bytes };
}

function newAccessCode() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const n = ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 900000 + 100000;
  return String(n);
}

function newTaskId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return "t" + Date.now().toString(36) + rand;
}

function bytesEqual(left, right) {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.length !== b.length) return false;
  if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  try {
    const { timingSafeEqual } = require("node:crypto");
    return timingSafeEqual(a, b);
  } catch (e) { /* Worker 没有 node:crypto 时走下面的比较 */ }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function accessGranted(provided, expected) {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(provided || ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(expected)))
  ]);
  return bytesEqual(left, right);
}

function weeklyMarkdown(entry) {
  const tasks = Array.isArray(entry.tasks) ? entry.tasks : [];
  return "# 小树英语周总结（" + entry.week + "）\n\n" + (entry.text || "") + "\n\n## 改进任务\n" +
    tasks.map((t) => "- " + (t && t.title ? t.title : "")).join("\n") + "\n";
}

function knowledgeWeeklyKey(week) {
  return "knowledge-base/weekly/周总结-" + week + ".md";
}

function rowsFromList(items, idOf) {
  const seen = new Set();
  const rows = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const id = idOf(items[i], i);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id: id, json: JSON.stringify(items[i]) });
  }
  rows.reverse();
  return rows;
}

module.exports = {
  DEFAULT_TYPE_GOALS,
  OCR_EXTRACT_PROMPT,
  OCR_CARD_PROMPT,
  BODY_LIMIT,
  normalizeSettings,
  clampSettings,
  parseCards,
  safeImageName,
  safeTaskId,
  decodeDataUrl,
  newAccessCode,
  newTaskId,
  accessGranted,
  weeklyMarkdown,
  knowledgeWeeklyKey,
  rowsFromList
};
