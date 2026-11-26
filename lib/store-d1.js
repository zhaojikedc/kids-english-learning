"use strict";

const {
  normalizeSettings,
  decodeDataUrl,
  safeImageName,
  newAccessCode,
  weeklyMarkdown,
  knowledgeWeeklyKey,
  rowsFromList
} = require("./core");

const BATCH = 100;

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

function fitOcrJson(task) {
  const copy = {
    status: task.status,
    cards: Array.isArray(task.cards) ? task.cards.slice() : [],
    error: String(task.error || ""),
    at: task.at || Date.now()
  };
  while (copy.cards.length && JSON.stringify(copy).length > 90000) copy.cards.pop();
  return JSON.stringify(copy);
}

async function getMeta(db, key) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  if (!row || row.value === undefined || row.value === null) return null;
  return String(row.value);
}

async function putMeta(db, key, value) {
  await db.prepare(
    "INSERT INTO meta (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated"
  ).bind(key, value, new Date().toISOString()).run();
}

async function runBatches(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH) {
    const chunk = statements.slice(i, i + BATCH);
    if (chunk.length) await db.batch(chunk);
  }
}

function newGeneration() {
  const salt = crypto.getRandomValues(new Uint8Array(1))[0];
  return Date.now() * 1000 + salt;
}

async function readGenerated(db, table) {
  if (table !== "cards" && table !== "logs") throw new Error("unknown table");
  const raw = await getMeta(db, table + "_generation");
  const gen = Number(raw || 0);
  if (!gen) return [];
  const sql = "SELECT json FROM " + table + " WHERE generation = ? ORDER BY position ASC";
  const queried = await db.prepare(sql).bind(gen).all();
  const results = (queried && queried.results) || [];
  return results.map((row) => parseJson(row.json, null)).filter(Boolean);
}

async function writeGenerated(db, table, items, idOf) {
  if (table !== "cards" && table !== "logs") throw new Error("unknown table");
  const gen = newGeneration();
  const rows = rowsFromList(items, idOf);
  const sql = "INSERT INTO " + table + " (generation, position, id, json) VALUES (?, ?, ?, ?)";
  const statements = rows.map((row, position) => db.prepare(sql).bind(gen, position, row.id, row.json));
  await runBatches(db, statements);
  await putMeta(db, table + "_generation", String(gen));
  await db.prepare("DELETE FROM " + table + " WHERE generation != ?").bind(gen).run();
}

function createD1Store(db, bucket) {
  return {
    async getSettings() {
      const raw = await getMeta(db, "settings");
      return normalizeSettings(raw ? parseJson(raw, {}) : {});
    },

    async putSettings(settings) {
      await putMeta(db, "settings", JSON.stringify({
        dailyGoal: settings.dailyGoal,
        typeGoals: settings.typeGoals
      }));
    },

    async getCards() {
      return readGenerated(db, "cards");
    },

    async putCards(cards) {
      await writeGenerated(db, "cards", cards, (card, index) => {
        const id = card && card.id !== undefined && card.id !== null ? String(card.id).slice(0, 120) : "";
        return id || ("card-" + index);
      });
    },

    async getChat() {
      const queried = await db.prepare("SELECT json FROM chat_messages ORDER BY position ASC").all();
      const results = (queried && queried.results) || [];
      return results.map((row) => parseJson(row.json, null)).filter(Boolean);
    },

    async putChat(chat) {
      const statements = [db.prepare("DELETE FROM chat_messages")];
      chat.forEach((message, index) => {
        statements.push(db.prepare("INSERT INTO chat_messages (position, json) VALUES (?, ?)").bind(index, JSON.stringify(message)));
      });
      await db.batch(statements);
    },

    async getProfile() {
      const raw = await getMeta(db, "profile");
      const d = raw ? parseJson(raw, {}) : {};
      return { summary: String(d.summary || ""), updated: d.updated || "" };
    },

    async putProfile(profile) {
      await putMeta(db, "profile", JSON.stringify({
        summary: profile.summary,
        updated: profile.updated
      }));
    },

    async getLogs() {
      return readGenerated(db, "logs");
    },

    async putLogs(logs) {
      await writeGenerated(db, "logs", logs, (entry, index) => {
        const id = entry && entry.id !== undefined && entry.id !== null ? String(entry.id).slice(0, 120) : "";
        return id || ("log-" + index);
      });
    },

    async getReports() {
      const queried = await db.prepare("SELECT json FROM reports ORDER BY week DESC").all();
      const results = (queried && queried.results) || [];
      return results.map((row) => parseJson(row.json, null)).filter(Boolean);
    },

    async putReports(reports) {
      const statements = [db.prepare("DELETE FROM reports")];
      reports.forEach((entry) => {
        statements.push(db.prepare("INSERT INTO reports (week, json) VALUES (?, ?)").bind(entry.week, JSON.stringify(entry)));
      });
      await db.batch(statements);
    },

    async saveWeekly(entry) {
      if (!bucket) return;
      try {
        await bucket.put(knowledgeWeeklyKey(entry.week), weeklyMarkdown(entry), {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" }
        });
      } catch (err) {
        console.error(JSON.stringify({
          message: "knowledge markdown write failed",
          error: err instanceof Error ? err.message : String(err)
        }));
      }
    },

    async getReset() {
      const raw = await getMeta(db, "reset");
      const d = raw ? parseJson(raw, {}) : {};
      return { at: d.at || "" };
    },

    async getOrCreateAccessCode() {
      const raw = await getMeta(db, "access");
      if (raw) {
        const parsed = parseJson(raw, {});
        if (parsed && parsed.code) return String(parsed.code);
      }
      const code = newAccessCode();
      const value = JSON.stringify({ code: code, created: new Date().toISOString() });
      await db.prepare(
        "INSERT INTO meta (key, value, updated) SELECT 'access', ?, ? WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'access')"
      ).bind(value, new Date().toISOString()).run();
      const again = await getMeta(db, "access");
      const parsed = again ? parseJson(again, {}) : {};
      return parsed && parsed.code ? String(parsed.code) : code;
    },

    async getTunnelUrl() {
      return "";
    },

    async saveImages(taskId, images) {
      const paths = [];
      if (!bucket) return paths;
      for (let i = 0; i < images.length; i++) {
        const decoded = decodeDataUrl(images[i]);
        if (!decoded) continue;
        const name = safeImageName(taskId + "-" + (i + 1) + "." + decoded.ext);
        if (!name) continue;
        try {
          await bucket.put("images/" + name, decoded.bytes, {
            httpMetadata: { contentType: decoded.contentType }
          });
          paths.push("/images/" + name);
        } catch (err) {
          console.error(JSON.stringify({
            message: "image upload failed",
            error: err instanceof Error ? err.message : String(err)
          }));
        }
      }
      return paths;
    },

    async cleanupOcr(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      await db.prepare("DELETE FROM ocr_tasks WHERE updated_ms < ?").bind(cutoff).run();
    },

    async getOcr(id) {
      const row = await db.prepare("SELECT json FROM ocr_tasks WHERE id = ?").bind(id).first();
      if (!row || !row.json) return null;
      return parseJson(row.json, null);
    },

    async putOcr(id, task) {
      const json = fitOcrJson(task);
      const at = Number(task.at) || Date.now();
      await db.prepare(
        "INSERT INTO ocr_tasks (id, json, updated_ms) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_ms = excluded.updated_ms"
      ).bind(id, json, at).run();
    }
  };
}

module.exports = { createD1Store };
