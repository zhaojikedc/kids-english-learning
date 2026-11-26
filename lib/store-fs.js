"use strict";

const fs = require("fs");
const path = require("path");
const {
  normalizeSettings,
  decodeDataUrl,
  safeImageName,
  newAccessCode,
  weeklyMarkdown
} = require("./core");

function createFsStore(options) {
  const root = options.root;
  const dataDir = path.join(root, "data");
  const imagesDir = options.imagesDir;
  const knowledgeDir = options.knowledgeDir;
  const tunnelLogs = options.tunnelLogs || ["/tmp/xy_cf_manual.log", "/tmp/xy_cf.err.log", "/tmp/xy_cf.log"];
  const ocrTasks = new Map();
  let accessCode = "";

  function ensureData() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(name, obj) {
    ensureData();
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(obj, null, 2));
  }

  function imagePath(name) {
    const file = path.resolve(imagesDir, name);
    const rootDir = path.resolve(imagesDir);
    if (file !== rootDir && !file.startsWith(rootDir + path.sep)) return "";
    return file;
  }

  return {
    async getSettings() {
      return normalizeSettings(readJson("settings.json", {}));
    },

    async putSettings(settings) {
      writeJson("settings.json", {
        updated: new Date().toISOString(),
        dailyGoal: settings.dailyGoal,
        typeGoals: settings.typeGoals
      });
    },

    async getCards() {
      const d = readJson("cards.json", { cards: [] });
      return Array.isArray(d.cards) ? d.cards : [];
    },

    async putCards(cards) {
      writeJson("cards.json", { updated: new Date().toISOString(), cards: cards });
    },

    async getChat() {
      const d = readJson("chat.json", { chat: [] });
      return Array.isArray(d.chat) ? d.chat : [];
    },

    async putChat(chat) {
      writeJson("chat.json", { updated: new Date().toISOString(), chat: chat });
    },

    async getProfile() {
      const d = readJson("profile.json", {});
      return { summary: String(d.summary || ""), updated: d.updated || "" };
    },

    async putProfile(profile) {
      writeJson("profile.json", { updated: profile.updated, summary: profile.summary });
    },

    async getLogs() {
      const d = readJson("logs.json", { logs: [] });
      return Array.isArray(d.logs) ? d.logs : [];
    },

    async putLogs(logs) {
      writeJson("logs.json", { updated: new Date().toISOString(), logs: logs });
    },

    async getReports() {
      const d = readJson("reports.json", { reports: [] });
      return Array.isArray(d.reports) ? d.reports : [];
    },

    async putReports(reports) {
      writeJson("reports.json", { reports: reports });
    },

    async saveWeekly(entry) {
      try {
        fs.mkdirSync(knowledgeDir, { recursive: true });
        fs.writeFileSync(path.join(knowledgeDir, "周总结-" + entry.week + ".md"), weeklyMarkdown(entry));
      } catch (e) { /* 知识库写入失败不影响保存 */ }
    },

    async getReset() {
      const d = readJson("reset.json", {});
      return { at: d.at || "" };
    },

    async getOrCreateAccessCode() {
      if (accessCode) return accessCode;
      const d = readJson("access.json", {});
      if (d.code) {
        accessCode = String(d.code);
        return accessCode;
      }
      accessCode = newAccessCode();
      try {
        writeJson("access.json", { code: accessCode, created: new Date().toISOString() });
      } catch (e) { /* 进程内仍使用这次生成的码 */ }
      return accessCode;
    },

    async getTunnelUrl() {
      let url = "";
      for (let i = 0; i < tunnelLogs.length && !url; i++) {
        try {
          const log = fs.readFileSync(tunnelLogs[i], "utf8");
          const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
          if (m && m.length) url = m[m.length - 1];
        } catch (e) { /* 日志不存在 */ }
      }
      return url;
    },

    async saveImages(taskId, images) {
      const paths = [];
      try { fs.mkdirSync(imagesDir, { recursive: true }); } catch (e) { /* ignore */ }
      images.forEach((dataUrl, i) => {
        const decoded = decodeDataUrl(dataUrl);
        if (!decoded) return;
        const name = safeImageName(taskId + "-" + (i + 1) + "." + decoded.ext);
        if (!name) return;
        const file = imagePath(name);
        if (!file) return;
        try {
          fs.writeFileSync(file, decoded.bytes);
          paths.push("/images/" + name);
        } catch (e) { /* ignore */ }
      });
      return paths;
    },

    async readImage(name) {
      const safe = safeImageName(name);
      if (!safe) return null;
      const file = imagePath(safe);
      if (!file) return null;
      try {
        const bytes = fs.readFileSync(file);
        const ext = path.extname(safe).toLowerCase();
        const contentType = ext === ".png" ? "image/png" : "image/jpeg";
        return { bytes: new Uint8Array(bytes), contentType: contentType };
      } catch (e) {
        return null;
      }
    },

    async cleanupOcr(maxAgeMs) {
      const now = Date.now();
      ocrTasks.forEach((task, id) => {
        if (now - task.at > maxAgeMs) ocrTasks.delete(id);
      });
    },

    async getOcr(id) {
      const task = ocrTasks.get(id);
      return task ? JSON.parse(JSON.stringify(task)) : null;
    },

    async putOcr(id, task) {
      ocrTasks.set(id, JSON.parse(JSON.stringify(task)));
    }
  };
}

module.exports = { createFsStore };
