/* 小树英语复习本 · 页面逻辑 */
(function () {
  "use strict";

  var L = window.XYLogic;
  var ACCESS_KEY = "xy_access_code";

  function showAccessModal() {
    var m = $("access-modal");
    if (m) m.classList.add("show");
  }

  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {});
      var code = localStorage.getItem(ACCESS_KEY) || "";
      if (code) headers["x-access-code"] = code;
      opts.headers = headers;
      return origFetch(url, opts).then(function (res) {
        if (res.status === 401) showAccessModal();
        return res;
      });
    };
  }
  var STORE_KEY = "xiaoshu_english_cards_v1";
  var CHAT_KEY = "xiaoshu_english_chat_v1";

  var cards = [];
  var currentFilter = "all";
  var reviewQueue = [];
  var reviewIndex = 0;
  var revealed = false;
  var chatHistory = [];
  var chatBusy = false;

  var ttsOn = true;
  var shadowTarget = null;
  var phase = "idle";
  var micGen = 0;
  var recordCtx = null;
  var recordStream = null;
  var recordSource = null;
  var recordProcessor = null;
  var recordMute = null;
  var recordChunks = [];
  var recordSampleRate = 16000;
  var recordTimer = null;
  var shadowWaited = 0;
  var IDLE_SPEECH_HINT = "点一下开始，再说一次结束。中英文自动识别。";
  var PCM_WORKLET = [
    "class PcmCaptureProcessor extends AudioWorkletProcessor {",
    "  process(inputs) {",
    "    var ch = inputs[0] && inputs[0][0];",
    "    if (ch && ch.length) this.port.postMessage(ch.slice(0));",
    "    return true;",
    "  }",
    "}",
    "registerProcessor('pcm-capture', PcmCaptureProcessor);"
  ].join("\n");

  var profile = { summary: "", updated: "" };
  var logs = [];
  var reports = [];
  var reportWeek = "";
  var settings = { dailyGoal: 10, typeGoals: { "单词": 4, "语法": 3, "例句": 3, "其他": 0 } };
  var tunnelUrl = "";
  var accessCode = "";
  var profileBusy = false;
  var reportBusy = false;

  var ocrWorker = null;
  var ocrBusy = false;
  var pickedFile = null;

  function $(id) { return document.getElementById(id); }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2000);
  }

  /* ---------- 存储 ---------- */
  function normalizeCards(arr) {
    return (Array.isArray(arr) ? arr : []).filter(function (c) {
      return c && c.question && c.answer;
    }).map(function (c) {
      return {
        id: c.id || uid(),
        type: c.type || "其他",
        unit: c.unit || "",
        question: c.question,
        answer: c.answer,
        note: c.note || "",
        image: c.image || "",
        wrongCount: typeof c.wrongCount === "number" ? c.wrongCount : 0,
        box: typeof c.box === "number" ? c.box : 0,
        due: c.due || L.todayStr(),
        created: c.created || L.todayStr()
      };
    });
  }

  function saveLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cards)); }
    catch (e) { toast("保存失败，存储空间可能满了"); }
  }

  var remoteTimer = null;
  function syncRemoteNow() {
    if (!window.fetch) return;
    fetch("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards: cards })
    }).catch(function () { /* 离线时忽略 */ });
  }
  function syncRemote() {
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(syncRemoteNow, 700);
  }

  function save() {
    saveLocal();
    syncRemote();
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      cards = normalizeCards(raw ? JSON.parse(raw) : []);
    } catch (e) { cards = []; }

    try {
      var ch = localStorage.getItem(CHAT_KEY);
      chatHistory = ch ? JSON.parse(ch) : [];
      if (!Array.isArray(chatHistory)) chatHistory = [];
    } catch (e) { chatHistory = []; }
  }

  var chatSyncTimer = null;
  function saveChat() {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-24))); }
    catch (e) { /* ignore */ }
    clearTimeout(chatSyncTimer);
    chatSyncTimer = setTimeout(function () {
      if (!window.fetch) return;
      fetch("/api/chatlog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: chatHistory.slice(-60) })
      }).catch(function () {});
    }, 700);
  }

  var LOGS_KEY = "xiaoshu_english_logs_v1";
  function loadLogsLocal() {
    try {
      var raw = localStorage.getItem(LOGS_KEY);
      logs = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(logs)) logs = [];
    } catch (e) { logs = []; }
  }

  var logTimer = null;
  function syncLogs() {
    clearTimeout(logTimer);
    logTimer = setTimeout(function () {
      if (!window.fetch) return;
      fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logs: logs.slice(-2000) })
      }).catch(function () {});
    }, 800);
  }

  function addLog(entry) {
    logs.push({
      id: uid(),
      ts: new Date().toISOString(),
      kind: entry.kind || "other",
      type: entry.type || "",
      topic: String(entry.topic || "").slice(0, 200),
      result: String(entry.result || "").slice(0, 60),
      detail: String(entry.detail || "").slice(0, 200)
    });
    if (logs.length > 2000) logs = logs.slice(-2000);
    try { localStorage.setItem(LOGS_KEY, JSON.stringify(logs)); } catch (e) { /* ignore */ }
    syncLogs();
  }

  function loadRemote() {
    if (!window.fetch) return Promise.resolve();
    function get(url) {
      return fetch(url, { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    }
    return Promise.all([
      get("/api/cards"), get("/api/chatlog"), get("/api/profile"), get("/api/logs"), get("/api/reports"), get("/api/settings"), get("/api/tunnel"), get("/api/access"), get("/api/reset")
    ]).then(function (res) {
      if (res[8] && res[8].at && localStorage.getItem("xy_reset_at") !== res[8].at) {
        localStorage.setItem("xy_reset_at", res[8].at);
        localStorage.removeItem("xiaoshu_english_cards_v1");
        localStorage.removeItem("xiaoshu_english_logs_v1");
        localStorage.removeItem("xiaoshu_english_chat_v1");
        location.reload();
        return;
      }
      var cardsRes = res[0], chatRes = res[1], profRes = res[2], logsRes = res[3], reportRes = res[4], setRes = res[5], tunnelRes = res[6], accessRes = res[7], resetRes = res[8];

      if (cardsRes && Array.isArray(cardsRes.cards)) {
        var remote = normalizeCards(cardsRes.cards);
        if (!remote.length) {
          if (cards.length) syncRemoteNow();
        } else {
          // 服务端为准：不再把本机旧缓存并回去，避免旧卡片被推回知识库
          cards = remote;
          saveLocal();
        }
      }

      if (chatRes && Array.isArray(chatRes.chat) && chatRes.chat.length) {
        chatHistory = chatRes.chat.slice(-24);
        try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory)); } catch (e) { /* ignore */ }
        renderChatHistory();
      } else if (chatHistory.length) {
        saveChat();
      }

      if (profRes && typeof profRes.summary === "string") {
        profile.summary = profRes.summary;
        profile.updated = profRes.updated || "";
      }

      if (logsRes && Array.isArray(logsRes.logs)) {
        logs = logsRes.logs;
      }

      if (reportRes && Array.isArray(reportRes.reports)) {
        reports = reportRes.reports;
      }

      if (setRes && typeof setRes.dailyGoal === "number") {
        settings = {
          dailyGoal: setRes.dailyGoal,
          typeGoals: setRes.typeGoals || settings.typeGoals
        };
      }

      if (tunnelRes && typeof tunnelRes.url === "string") {
        tunnelUrl = tunnelRes.url;
      }

      if (accessRes && accessRes.code) {
        accessCode = String(accessRes.code);
      }

      renderProfileBar();
      renderBoard();
    }).catch(function () { /* 服务不在就用本地 */ });
  }

  /* ---------- 跨天切换 ---------- */
  var lastDay = L.todayStr();

  function checkDayChange() {
    var t = L.todayStr();
    if (t === lastDay) return;
    var prev = lastDay;
    lastDay = t;

    var backlog = 0;
    cards.forEach(function (c) {
      if (String(c.due || "") <= prev) backlog++;
    });

    updateStats();
    renderCards();
    renderReviewIdle();
    renderBoard();
    toast(backlog > 0
      ? "新的一天，昨天还有 " + backlog + " 张没复习，已排到今天最前面"
      : "新的一天，任务已更新");
  }

  /* ---------- 自动同步 ---------- */
  function syncCards(silent) {
    if (!window.fetch) return;
    if ($("review-active") && $("review-active").style.display !== "none") return;
    var changed = false;

    fetch("/api/cards", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var remote = normalizeCards(d.cards || []);
        if (!remote.length) return;
        var byId = {};
        remote.forEach(function (c) { byId[c.id] = true; });
        var merged = remote.slice();
        cards.forEach(function (c) { if (!byId[c.id]) merged.push(c); });
        if (merged.length !== cards.length) {
          cards = merged;
          saveLocal();
          changed = true;
        }
      })
      .catch(function () { /* ignore */ });

    fetch("/api/logs", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (Array.isArray(d.logs)) {
          logs = d.logs;
          try { localStorage.setItem(LOGS_KEY, JSON.stringify(logs)); } catch (e) { /* ignore */ }
          changed = true;
        }
      })
      .catch(function () { /* ignore */ });

    setTimeout(function () {
      if (!changed) return;
      updateStats();
      renderCards();
      renderReviewIdle();
      renderBoard();
      if (!silent) toast("已同步最新数据");
    }, 1200);
  }

    /* ---------- 统计 ---------- */
  function dueCards() {
    var t = L.todayStr();
    return cards.filter(function (c) { return L.isDue(c, t); });
  }

  function updateStats() {
    var master = cards.filter(function (c) { return c.box >= 4; }).length;
    $("stat-total").textContent = cards.length;
    $("stat-due").textContent = dueCards().length;
    $("stat-master").textContent = master;
  }

  /* ---------- 气泡 ---------- */
  var bubbles = [
    "今天也来学一点点吧！",
    "学过的别忘了，复习一下更牢。",
    "有不会的，去聊天里问我。",
    "一次记一张，慢慢就多了。",
    "加油，小树！"
  ];
  function setBubble() {
    var el = $("buddy-bubble");
    if (el) el.textContent = bubbles[Math.floor(Math.random() * bubbles.length)];
  }

  /* ---------- 复习 ---------- */
  var DAILY_GOAL = 10;

  function todayReviewedCount() {
    var t = L.todayStr();
    return logs.filter(function (l) {
      return l.kind === "review" && l.ts && l.ts.slice(0, 10) === t;
    }).length;
  }

  function streakDays() {
    var days = {};
    logs.forEach(function (l) {
      if (l.kind === "review" && l.ts) days[l.ts.slice(0, 10)] = true;
    });
    var n = 0;
    var d = new Date();
    if (!days[L.todayStr(d)]) d.setDate(d.getDate() - 1);
    while (true) {
      var s = L.todayStr(d);
      if (days[s]) { n++; d.setDate(d.getDate() - 1); } else break;
    }
    return n;
  }

  function weekLabel(d) {
    var w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + w[d.getDay()];
  }

  function reviewDays() {
    var days = {};
    logs.forEach(function (l) {
      if (l.kind === "review" && l.ts) {
        var d = l.ts.slice(0, 10);
        days[d] = (days[d] || 0) + 1;
      }
    });
    return days;
  }

  function dailyGoalValue() {
    return Math.max(1, settings.dailyGoal || 10);
  }

  function checkinDays() {
    var raw = reviewDays();
    var goal = dailyGoalValue();
    var days = {};
    Object.keys(raw).forEach(function (d) {
      if (raw[d] >= goal) days[d] = true;
    });
    return days;
  }

  function weekKeyOf(dateStr) {
    var d = new Date(dateStr + "T00:00:00");
    var day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return L.todayStr(d);
  }

  function weekStats(targetWeek) {
    var days = checkinDays();
    var weeks = {};
    Object.keys(days).forEach(function (ds) {
      var wk = weekKeyOf(ds);
      if (!weeks[wk]) weeks[wk] = [];
      weeks[wk].push(ds);
    });
    var thisWeek = targetWeek || weekStart();
    var today = L.todayStr();
    var out = { totalPoints: 0, totalMoney: 0, weekPoints: 0, weekMoney: 0, continuous: false };

    Object.keys(weeks).forEach(function (wk) {
      var list = weeks[wk].sort();
      var points = list.length;
      out.totalPoints += points;

      var end = wk === thisWeek ? (days[today] ? today : L.addDays(today, -1)) : list[list.length - 1];
      var continuous = true;
      var d = new Date(wk + "T00:00:00");
      var endD = new Date(end + "T00:00:00");
      while (d <= endD) {
        if (!days[L.todayStr(d)]) { continuous = false; break; }
        d.setDate(d.getDate() + 1);
      }
      if (end < wk) continuous = true;

      var money = points * (continuous ? 2 : 1);
      out.totalMoney += money;
      if (wk === thisWeek) {
        out.weekPoints = points;
        out.weekMoney = money;
        out.continuous = continuous;
      }
    });
    return out;
  }

  function calendarHtml() {
    var raw = reviewDays();
    var goal = dailyGoalValue();
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();
    var today = L.todayStr(now);
    var first = new Date(y, m, 1);
    var pad = (first.getDay() + 6) % 7;
    var total = new Date(y, m + 1, 0).getDate();
    var cells = [];
    var i, d;
    for (i = 0; i < pad; i++) cells.push('<div class="cal-cell blank"></div>');
    var monthCount = 0;
    for (d = 1; d <= total; d++) {
      var ds = L.todayStr(new Date(y, m, d));
      var cnt = raw[ds] || 0;
      var done = cnt >= goal;
      var partial = cnt > 0 && !done;
      var missed = ds < today && cnt === 0;
      if (done) monthCount++;
      cells.push('<div class="cal-cell' + (done ? ' done' : '') + (partial ? ' partial' : '') +
        (missed ? ' missed' : '') +
        (ds === today ? ' today' : '') + (ds > today ? ' future' : '') + '">' +
        '<span>' + d + '</span>' + (done ? '<i>✓</i>' : partial ? '<i>·</i>' : missed ? '<i>×</i>' : '') + '</div>');
    }
    var wd = ["一", "二", "三", "四", "五", "六", "日"].map(function (x) {
      return '<div class="cal-wd">' + x + '</div>';
    }).join("");
    return '<div class="cal-card">' +
      '<div class="cal-head"><span>' + y + "年" + (m + 1) + '月</span>' +
      '<span>本月打卡 <b>' + monthCount + '</b> 天</span></div>' +
      '<div class="cal-grid">' + wd + cells.join("") + '</div>' +
      '</div>';
  }

  function todayDoneByType() {
    var t = L.todayStr();
    var m = {};
    logs.forEach(function (l) {
      if (l.kind === "review" && l.ts && l.ts.slice(0, 10) === t) {
        var k = l.type || "其他";
        m[k] = (m[k] || 0) + 1;
      }
    });
    return m;
  }

  function todayPlan(due) {
    var total = Math.min(due.length, dailyGoalValue());
    var types = ["单词", "语法", "例句", "其他"];
    var counts = {};
    types.forEach(function (t) {
      counts[t] = due.filter(function (c) { return (c.type || "其他") === t; }).length;
    });

    var tg = settings.typeGoals || {};
    var plan = {};
    var used = 0;
    types.forEach(function (t) {
      var want = Math.max(0, Number(tg[t]) || 0);
      var n = Math.min(want, counts[t], total - used);
      plan[t] = n;
      used += n;
    });

    var remain = total - used;
    var guard = 0;
    while (remain > 0 && guard < 300) {
      var t = types[guard % 4];
      if (plan[t] < counts[t]) { plan[t]++; remain--; }
      guard++;
    }
    return { total: total, plan: plan, counts: counts };
  }

  function renderReviewIdle() {
    var due = dueCards();
    var goal = Math.max(1, settings.dailyGoal || 10);
    var taskTotal = Math.min(due.length, goal);

    var planInfo = todayPlan(due);
    var plan = planInfo.plan;
    var byType = { "单词": [], "语法": [], "例句": [], "其他": [] };
    due.forEach(function (c) {
      var t = byType[c.type] ? c.type : "其他";
      byType[t].push(c);
    });
    var doneByType = todayDoneByType();

    var types = ["单词", "语法", "例句", "其他"];
    var completed = types.reduce(function (sum, t) {
      return sum + Math.min(doneByType[t] || 0, plan[t] || 0);
    }, 0);
    var checked = taskTotal > 0 && completed >= taskTotal;
    var pct = taskTotal ? Math.min(100, Math.round(completed / taskTotal * 100)) : 0;

    $("review-active").style.display = "none";
    $("review-idle").style.display = "block";
    var board = $("review-board");
    if (!board) return;

    var typesHtml = types.map(function (t) {
      var n = plan[t] || 0;
      var finished = n > 0 && (doneByType[t] || 0) >= n;
      return '<button class="task-type' + (finished ? ' done' : '') + '" data-type="' + t + '"' +
        (n ? '' : ' disabled') + '>' +
        t + ' <b>' + (finished ? '✓ 已完成' : n + ' 张') + '</b></button>';
    }).join("");

    board.innerHTML = '<div class="task-card">' +
      '<div class="task-top">' +
        '<div><div class="task-title">今日任务</div><div class="task-date">' + weekLabel(new Date()) + '</div></div>' +
        '<div class="task-check' + (checked ? ' done' : '') + '">' + (checked ? '已打卡' : (completed > 0 ? '打卡中' : '待打卡')) + '</div>' +
      '</div>' +
      '<div class="task-bar"><div style="width:' + pct + '%"></div></div>' +
      '<div class="task-nums">今日任务 <b>' + taskTotal + '</b> 张 · 已完成 <b>' + completed + '</b> 张</div>' +
      '<div class="task-types">' + typesHtml + '</div>' +
      (checked
        ? '<div class="task-done">🎉 今日打卡完成，+1 积分，明天见！</div>'
        : '<button class="btn primary wide" id="review-start">开始今日复习 🚀</button>') +
      '</div>' +
      '<div class="task-streak">🔥 连续打卡 <b>' + streakDays() + '</b> 天</div>' +
      (canManage() ? '<div style="text-align:center; margin-top:10px;"><button class="mini-btn" id="goal-open">⚙️ 每日目标</button> <button class="mini-btn" id="reset-today">🔄 重置今日</button></div>' : '') +
      calendarHtml();
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function startReview(type) {
    var all = dueCards().slice().sort(function (a, b) {
      var wa = a.wrongCount || 0, wb = b.wrongCount || 0;
      if (wa !== wb) return wb - wa;
      return String(a.due || "").localeCompare(String(b.due || ""));
    });
    var pool = all;
    if (type) {
      pool = all.filter(function (c) { return (c.type || "其他") === type; });
      var plan = todayPlan(all).plan;
      var n = plan[type] || 0;
      if (n > 0) pool = pool.slice(0, n);
    } else {
      var planAll = todayPlan(all);
      var picked = [];
      var types = ["单词", "语法", "例句", "其他"];
      types.forEach(function (t) {
        picked = picked.concat(pool.filter(function (c) { return (c.type || "其他") === t; }).slice(0, planAll.plan[t] || 0));
      });
      pool = picked;
    }
    reviewQueue = shuffle(pool.slice());
    reviewQueue.sort(function (a, b) {
      return (b.wrongCount || 0) - (a.wrongCount || 0);
    });
    reviewQueue.forEach(function (c) { c._wrong = 0; });
    reviewIndex = 0;
    if (reviewQueue.length === 0) { renderReviewIdle(); return; }
    $("review-idle").style.display = "none";
    $("review-active").style.display = "block";
    showCard();
  }

  var reviewAnswered = false;
  var reviewTry = 0;

  function cnScore(correct, input) {
    var na = String(correct || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "").toLowerCase();
    var nb = String(input || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "").toLowerCase();
    if (!na || !nb) return 0;
    if (nb.indexOf(na) >= 0 || na.indexOf(nb) >= 0) return 100;
    var grams = [];
    for (var i = 0; i < na.length - 1; i++) grams.push(na.substr(i, 2));
    if (!grams.length) return na === nb ? 100 : 0;
    var hit = 0;
    grams.forEach(function (g) { if (nb.indexOf(g) >= 0) hit++; });
    return Math.round(hit / grams.length * 100);
  }

  function scoreAnswer(correct, input) {
    var hasEn = /[a-zA-Z]{3,}/.test(correct);
    var hasCn = /[\u4e00-\u9fa5]/.test(correct);
    if (hasEn && !hasCn) return L.compareWords(correct, input).score;
    if (hasCn && !hasEn) return cnScore(correct, input);
    return Math.round((L.compareWords(correct, input).score + cnScore(correct, input)) / 2);
  }

  function answerHint(c) {
    var ansEn = /[a-zA-Z]{3,}/.test(c.answer) && !/[\u4e00-\u9fa5]/.test(c.answer);
    var qEn = /[a-zA-Z]{3,}/.test(c.question) && !/[\u4e00-\u9fa5]/.test(c.question);
    if (c.type === "例句") return "把上面的中文翻译成英文，写出完整句子。";
    if (c.type === "单词") return ansEn ? "用英文写出这个单词。" : "写出这个词的中文意思。";
    if (c.type === "语法") return ansEn ? "用英文写出答案。" : "用中文回答上面的问题。";
    if (ansEn && !qEn) return "用英文写出答案。";
    if (!ansEn && qEn) return "写出它的中文意思。";
    return ansEn ? "用英文写出答案。" : "用中文写出答案。";
  }

  function showCard() {
    var c = reviewQueue[reviewIndex];
    if (!c) { finishReview(); return; }
    reviewAnswered = false;
    reviewTry = 0;
    $("review-pos").textContent = "第 " + (reviewIndex + 1) + " / " + reviewQueue.length + " 张";
    $("review-progress2").style.width = (reviewIndex / reviewQueue.length * 100) + "%";
    $("review-type").textContent = c.type + (c.unit ? " · " + c.unit : "");
    $("review-question").textContent = c.question;
    $("review-ask").textContent = answerHint(c);
    $("review-feedback").textContent = "";
    $("review-feedback").className = "review-feedback";
    $("review-input").value = "";
    $("review-input").placeholder = /[a-zA-Z]{3,}/.test(c.answer) && !/[\u4e00-\u9fa5]/.test(c.answer)
      ? "用英文写出答案"
      : "用中文写出答案";
    $("review-submit").disabled = false;
    setTimeout(function () { $("review-input").focus(); }, 50);
  }

  function submitAnswer() {
    var c = reviewQueue[reviewIndex];
    if (!c || reviewAnswered) return;
    var text = $("review-input").value.trim();
    if (!text) {
      $("review-feedback").textContent = "先写点东西再提交";
      return;
    }
    var score = scoreAnswer(c.answer, text);
    if (score >= 75) {
      reviewAnswered = true;
      var g = c._wrong ? 0 : 2;
      if (!c._wrong && c.wrongCount > 0) c.wrongCount = Math.max(0, c.wrongCount - 1);
      var r = L.gradeCard(c, g, L.todayStr());
      c.box = r.box;
      c.due = r.due;
      addLog({ kind: "review", type: c.type, topic: c.question, result: c._wrong ? "忘了" : "熟练" });
      save();
      $("review-feedback").textContent = c._wrong ? "答对了，明天再复习一遍。" : "一次就答对，掌握得不错！";
      $("review-feedback").className = "review-feedback " + (c._wrong ? "mid" : "good");
      setTimeout(function () { reviewIndex++; updateStats(); showCard(); }, 900);
      return;
    }

    c._wrong = (c._wrong || 0) + 1;
    c.wrongCount = (c.wrongCount || 0) + 1;
    reviewTry = (reviewTry || 0) + 1;
    addLog({ kind: "wrong", type: c.type, topic: c.question, result: text, detail: c.answer });

    if (reviewTry >= 2) {
      reviewAnswered = true;
      var r2 = L.gradeCard(c, 0, L.todayStr());
      c.box = r2.box;
      c.due = r2.due;
      save();
      $("review-feedback").textContent = "正确答案：" + c.answer + "。这张明天再来。";
      $("review-feedback").className = "review-feedback bad";
      setTimeout(function () { reviewIndex++; updateStats(); showCard(); }, 1800);
      return;
    }

    $("review-feedback").textContent = "还不太对，再想想，也可以换个说法。";
    $("review-feedback").className = "review-feedback bad";
  }

  function finishReview() {
    $("review-active").style.display = "none";
    renderReviewIdle();
    updateStats();
    toast("这一轮复习完了，真棒！");
    setBubble();
  }

  /* ---------- 知识库 ---------- */
  function renderCards() {
    var list = $("cards-list");
    var t = L.todayStr();
    var items = cards.slice().reverse();
    if (currentFilter !== "all") {
      items = items.filter(function (c) { return c.type === currentFilter; });
    }
    if (items.length === 0) {
      list.innerHTML = '<div class="empty"><span class="big">📭</span>还没有卡片。去「录入」加一张。</div>';
      return;
    }
    var html = "";
    items.forEach(function (c) {
      var state = L.isDue(c, t) ? "待复习" : "下次 " + c.due;
      var stars = c.box >= 6 ? "★★★★★" : c.box >= 4 ? "★★★★" : c.box >= 2 ? "★★★" : c.box >= 1 ? "★★" : "★";
      html += '<div class="card-item t-' + esc(c.type) + '">'
        + '<span class="tag">' + esc(c.type) + '</span>'
        + (c.unit ? '<span class="unit">' + esc(c.unit) + '</span>' : '')
        + '<div class="q">' + esc(c.question) + '</div>'
        + '<div class="a">' + esc(c.answer) + '</div>'
        + (c.image ? '<div class="card-imgpath">📷 桌面/个人知识库/05-课本图片/' + esc(String(c.image).replace("/images/", "")) + '</div>' : '')
        + '<div class="foot"><span><span class="stars">' + stars + '</span> · ' + state + '</span>'
        + (canManage() ? '<button class="del" data-edit="' + c.id + '">编辑</button><button class="del" data-del="' + c.id + '">删除</button>' : '') + '</div>'
        + '</div>';
    });
    list.innerHTML = html;

    Array.prototype.forEach.call(list.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-del");
        if (!confirm("确定删掉这张卡片？")) return;
        cards = cards.filter(function (c) { return c.id !== id; });
        save();
        updateStats();
        renderCards();
        toast("删掉了");
      });
    });

    Array.prototype.forEach.call(list.querySelectorAll("[data-edit]"), function (btn) {
      btn.addEventListener("click", function () {
        openEdit(btn.getAttribute("data-edit"));
      });
    });
  }

  /* ---------- 编辑卡片 ---------- */
  var editingId = null;

  function openEdit(id) {
    var c = null;
    cards.forEach(function (x) { if (x.id === id) c = x; });
    if (!c) return;
    editingId = id;
    $("edit-type").value = c.type || "其他";
    $("edit-unit").value = c.unit || "";
    $("edit-question").value = c.question || "";
    $("edit-answer").value = c.answer || "";
    $("edit-modal").classList.add("show");
  }

  function saveEdit() {
    var c = null;
    cards.forEach(function (x) { if (x.id === editingId) c = x; });
    if (!c) return;
    var q = $("edit-question").value.trim();
    var a = $("edit-answer").value.trim();
    if (!q || !a) { toast("问题和答案都要填"); return; }
    c.type = $("edit-type").value;
    c.unit = $("edit-unit").value.trim();
    c.question = q;
    c.answer = a;
    save();
    $("edit-modal").classList.remove("show");
    renderCards();
    toast("改好了");
  }

  /* ---------- 录入 ---------- */
  function saveCard() {
    var type = $("f-type").value;
    var unit = $("f-unit").value.trim();
    var q = $("f-question").value.trim();
    var a = $("f-answer").value.trim();
    var note = $("f-note").value.trim();
    if (!q || !a) { toast("问题和答案都要填哦"); return; }
    cards.push({
      id: uid(), type: type, unit: unit, question: q, answer: a, note: note,
      box: 0, due: L.todayStr(), created: L.todayStr()
    });
    save();
    $("f-question").value = "";
    $("f-answer").value = "";
    $("f-note").value = "";
    toast("存好了，明天会提醒复习");
    updateStats();
    renderCards();
    setBubble();
  }

  function clearForm() {
    $("f-unit").value = "";
    $("f-question").value = "";
    $("f-answer").value = "";
    $("f-note").value = "";
  }

  /* ---------- 拍照生成卡片 ---------- */
  var pickedImages = [];
  var aiBusy = false;

  function pickPhoto() {
    $("photo-input").click();
  }

  function compressImage(file, maxSize) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.78));
        } catch (e) {
          resolve(null);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function pdfToImages(file, maxPages) {
    return new Promise(function (resolve) {
      if (!window.pdfjsLib) { resolve([]); return; }
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://fastly.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
      var reader = new FileReader();
      reader.onload = function () {
        pdfjsLib.getDocument({ data: reader.result }).promise.then(function (pdf) {
          var n = Math.min(pdf.numPages, maxPages);
          var out = [];
          var chain = Promise.resolve();
          for (var i = 1; i <= n; i++) {
            (function (pageNum) {
              chain = chain.then(function () {
                return pdf.getPage(pageNum).then(function (page) {
                  var viewport = page.getViewport({ scale: 2 });
                  var canvas = document.createElement("canvas");
                  canvas.width = viewport.width;
                  canvas.height = viewport.height;
                  return page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise
                    .then(function () { out.push(canvas.toDataURL("image/jpeg", 0.82)); });
                });
              });
            })(i);
          }
          chain.then(function () { resolve(out); }).catch(function () { resolve(out); });
        }).catch(function () { resolve([]); });
      };
      reader.onerror = function () { resolve([]); };
      reader.readAsArrayBuffer(file);
    });
  }

  function onPhotoPicked(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    var room = 10 - pickedImages.length;
    if (room <= 0) { toast("一次最多 10 张，先识别或删掉几张"); return; }

    var pdf = null;
    var images = [];
    files.forEach(function (f) {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) { if (!pdf) pdf = f; }
      else if (/^image\//.test(f.type)) images.push(f);
    });

    if (pdf) {
      autoProcessPdf(pdf);
      return;
    }

    if (images.length > room) toast("最多 10 张，先处理这 " + room + " 张");
    images = images.slice(0, room);
    $("ocr-status").textContent = "正在处理图片…";
    Promise.all(images.map(function (f) { return compressImage(f, 1200); })).then(function (urls) {
      urls.forEach(function (u) { if (u) pickedImages.push(u); });
      renderPhotoGrid();
      if (pickedImages.length) {
        $("ocr-status").textContent = "选好了 " + pickedImages.length + " 张，点「AI 生成卡片」。";
      }
    });
  }

  function renderPhotoGrid() {
    var grid = $("photo-grid");
    grid.innerHTML = "";
    pickedImages.forEach(function (src, i) {
      var box = document.createElement("div");
      box.className = "photo-thumb";
      var img = document.createElement("img");
      img.src = src;
      img.alt = "第 " + (i + 1) + " 张";
      var rm = document.createElement("button");
      rm.className = "rm";
      rm.textContent = "×";
      rm.title = "删掉这张";
      rm.onclick = function () {
        pickedImages.splice(i, 1);
        renderPhotoGrid();
      };
      box.appendChild(img);
      box.appendChild(rm);
      grid.appendChild(box);
    });
    $("ai-gen").style.display = pickedImages.length ? "inline-block" : "none";
    if (!pickedImages.length && !aiBusy) $("ocr-status").textContent = "";
  }

  var pendingCards = [];

  function renderPreview(made) {
    pendingCards = made.slice();
    var box = $("preview-box");
    if (!box) return;
    if (!pendingCards.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="preview-head">待确认 ' + pendingCards.length + ' 张</div>' +
      pendingCards.map(function (c, i) {
        return '<div class="preview-item" data-idx="' + i + '">' +
          '<div class="preview-q"><span class="tag">' + esc(c.type) + '</span>' + esc(c.question) + '</div>' +
          '<div class="preview-a">' + esc(c.answer) + '</div>' +
          '<button class="btn small" data-rm="' + i + '">不要这张</button></div>';
      }).join("") +
      '<div class="row" style="margin-top:10px;">' +
      '<button class="btn primary" id="preview-confirm" style="flex:1;">确认入库</button>' +
      '<button class="btn" id="preview-cancel">取消</button></div>';

    Array.prototype.forEach.call(box.querySelectorAll("[data-rm]"), function (btn) {
      btn.addEventListener("click", function () {
        var i = Number(btn.getAttribute("data-rm"));
        pendingCards[i] = null;
        btn.closest(".preview-item").remove();
        var left = pendingCards.filter(Boolean).length;
        var head = box.querySelector(".preview-head");
        if (head) head.textContent = "待确认 " + left + " 张";
      });
    });

    $("preview-confirm").addEventListener("click", confirmPreview);
    $("preview-cancel").addEventListener("click", function () {
      pendingCards = [];
      box.innerHTML = "";
      $("ocr-status").textContent = "已取消，没有入库。";
    });
  }

  function confirmPreview() {
    var list = pendingCards.filter(Boolean);
    var existing = {};
    cards.forEach(function (c) { existing[c.type + "|" + c.question] = true; });
    var added = 0;
    list.forEach(function (c) {
      var k = c.type + "|" + c.question;
      if (existing[k]) return;
      existing[k] = true;
      cards.push({
        id: uid(), type: c.type, unit: c.unit || "", question: c.question,
        answer: c.answer, note: c.note || "", image: c.image || "",
        box: 0, due: L.todayStr(), created: L.todayStr()
      });
      added++;
    });
    pendingCards = [];
    $("preview-box").innerHTML = "";
    save();
    updateStats();
    renderCards();
    pickedImages = [];
    renderPhotoGrid();
    $("ocr-status").textContent = "已入库 " + added + " 张卡片。";
    toast("入库 " + added + " 张");
    setBubble();
  }

  function pollOcr(id, started) {
    return fetch("/api/ocr-cards/" + id, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "done") return d.cards || [];
        if (d.status === "error") throw new Error(d.error || "识别失败");
        if (Date.now() - started > 600000) throw new Error("识别超时");
        var sec = Math.round((Date.now() - started) / 1000);
        $("ocr-status").textContent = "识别中…已等 " + sec + " 秒，别关页面";
        return new Promise(function (resolve) { setTimeout(resolve, 2000); })
          .then(function () { return pollOcr(id, started); });
      });
  }

  function ocrImages(images) {
    return fetch("/api/ocr-cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: images })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.id) throw new Error(d.error || "提交失败");
        return pollOcr(d.id, Date.now());
      });
  }

  function aiGenerate() {
    if (aiBusy) return;
    if (!pickedImages.length) { toast("先拍或选几张课本图"); return; }
    aiBusy = true;
    var btn = $("ai-gen");
    btn.disabled = true;
    $("ocr-status").textContent = "已提交，AI 开始看图…";

    ocrImages(pickedImages)
      .then(function (made) {
        if (!made.length) {
          $("ocr-status").textContent = "没认出卡片，换张清楚点的图再试。";
          return;
        }
        renderPreview(made);
        $("ocr-status").textContent = "生成好了，先检查一遍，确认无误再入库。";
      })
      .catch(function (err) {
        $("ocr-status").textContent = "生成失败：" + (err && err.message ? err.message : "网络问题") + "（先试 1 张）";
      })
      .then(function () {
        aiBusy = false;
        btn.disabled = false;
      });
  }

  function renderPdfPages(pdf, from, to) {
    var out = [];
    var chain = Promise.resolve();
    for (var i = from; i <= to; i++) {
      (function (pageNum) {
        chain = chain.then(function () {
          return pdf.getPage(pageNum).then(function (page) {
            var viewport = page.getViewport({ scale: 2 });
            var canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            return page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise
              .then(function () { out.push(canvas.toDataURL("image/jpeg", 0.8)); });
          });
        });
      })(i);
    }
    return chain.then(function () { return out; });
  }

  async function autoProcessPdf(file) {
    if (!window.pdfjsLib) { toast("PDF 组件没加载，检查网络"); return; }
    if (aiBusy) { toast("上一批还在跑，等它完成"); return; }
    aiBusy = true;
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://fastly.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

    var allCards = [];
    try {
      var buf = await file.arrayBuffer();
      var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      var total = pdf.numPages;
      var per = 10;
      var batches = Math.ceil(total / per);
      $("ocr-status").textContent = "整本 " + total + " 页，分 " + batches + " 批处理…";

      for (var b = 0; b < batches; b++) {
        var from = b * per + 1;
        var to = Math.min(total, from + per - 1);
        $("ocr-status").textContent = "第 " + (b + 1) + "/" + batches + " 批（第 " + from + " 到 " + to + " 页）… 已生成 " + allCards.length + " 张";
        try {
          var images = await renderPdfPages(pdf, from, to);
          var cards = await ocrImages(images);
          allCards = allCards.concat(cards);
        } catch (e) { /* 这批失败跳过 */ }
      }
    } catch (e) {
      $("ocr-status").textContent = "PDF 打不开：" + (e && e.message ? e.message : "文件异常");
      aiBusy = false;
      return;
    }

    aiBusy = false;
    if (!allCards.length) {
      $("ocr-status").textContent = "整本没认出卡片，检查 PDF 是否清晰。";
      return;
    }
    renderPreview(allCards);
    $("ocr-status").textContent = "整本处理完了，共 " + allCards.length + " 张，检查后确认入库。";
  }

  /* ---------- 聊天 ---------- */
  // 服务端聊天最多等 240 秒。页面再多留 10 秒，好接住服务端的超时，而不是自己先掐断。
  var CHAT_WAIT_MS = 250000;

  function isLocalPage() {
    var host = "";
    try { host = String(location.hostname || "").toLowerCase(); } catch (e) { host = ""; }
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }

  function chatFailText(err) {
    if (err && err.name === "AbortError") {
      return "等太久了，可能网络卡了，再试一次。";
    }
    if (err && err.reachedServer) {
      return (err.message && String(err.message).trim()) || "小老师这次没答上来，再试一次。";
    }
    if (isLocalPage()) {
      return "连不上小老师服务。是不是服务没启动？看看有没有打开「启动小树英语.command」。";
    }
    return "连不上小老师服务，检查网络后再试一次。";
  }

  function cardDigest() {
    var list = cards.slice(-200);
    if (!list.length) return "（他还没录入任何卡片）";
    return list.map(function (c) {
      var q = (c.question || "").slice(0, 80);
      var a = (c.answer || "").slice(0, 100);
      return "【" + c.type + (c.unit ? "·" + c.unit : "") + "】" + q + " → " + a;
    }).join("\n");
  }

  function systemPrompt() {
    var lines = [
      "你是三年级小学生小树的英语小老师，在「小树英语复习本」里陪他复习。",
      "他在学剑桥少儿英语二级 Movers，二级以语法为主，单词练得少，之前学过的容易忘。",
      "要求：",
      "1. 用简单友好的中文讲，英文例句要短；他问英文就给英文，问中文就用中文解释。",
      "2. 优先围绕下面他学过的卡片回答，不要扯他没学过的东西。",
      "3. 他问「学过什么」时，按卡片类型和单元列出来，别编。",
      "4. 他会打英文句子，帮他改：先给正确的，再说错哪了。",
      "5. 回答短一点，一般不超过 120 字；他要求详细再展开。",
      "6. 不确定的就说「这个还没学到，我们先记下来」。",
      "7. 不要用星号、井号、短横线这类 Markdown 标记，用普通中文句子和换行。",
      "",
      "他学过的卡片：",
      cardDigest()
    ];
    if (profile.summary) {
      lines.push("", "小树的学习档案（你之前总结的，作背景参考）：", profile.summary);
    }
    return lines.join("\n");
  }

  function addMsg(role, text, extraClass, isHtml, who) {
    var wrap = $("chat-messages");
    var el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "me" : "bot") + (extraClass ? " " + extraClass : "");
    if (role === "user") {
      el.textContent = text;
    } else {
      var body = isHtml ? text : esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      el.innerHTML = '<div class="who">' + (who || "🦉 小树英语") + '</div>' + body;
    }
    wrap.appendChild(el);
    wrap.scrollTop = wrap.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    return el;
  }

  function renderChatHistory() {
    var wrap = $("chat-messages");
    wrap.innerHTML = "";
    var intro = document.createElement("div");
    intro.className = "msg bot";
    intro.innerHTML = '<div class="who">🦉 小树英语</div>我是你的英语小老师。可以问我：学过的时态有哪些、这个词怎么用、帮我造个句子。';
    wrap.appendChild(intro);
    chatHistory.forEach(function (m) {
      addMsg(m.role === "user" ? "user" : "bot", m.content);
    });
  }

  function sendChat() {
    if (chatBusy) return;
    var input = $("chat-input");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMsg("user", text);
    chatHistory.push({ role: "user", content: text });
    saveChat();
    addLog({ kind: "chat", topic: text });

    chatBusy = true;
    $("chat-send").disabled = true;
    var typing = addMsg("bot", "想一想…", "typing");

    var messages = [{ role: "system", content: systemPrompt() }]
      .concat(chatHistory.slice(-12).map(function (m) { return { role: m.role, content: m.content }; }));

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, CHAT_WAIT_MS);

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages }),
      signal: ctrl.signal
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { ok: r.ok, d: d };
        }, function () {
          var bad = new Error(r.ok ? "返回内容读不懂" : ("服务返回错误（" + r.status + "）"));
          bad.reachedServer = true;
          throw bad;
        });
      })
      .then(function (res) {
        clearTimeout(timer);
        typing.remove();
        if (!res.ok) {
          var failed = new Error((res.d && res.d.error) || "服务返回错误");
          failed.reachedServer = true;
          throw failed;
        }
        var answer = (res.d.content || "").trim();
        if (!answer) answer = "我这边没组织好答案，你再问一次？";
        addMsg("bot", answer);
        speak(answer);
        chatHistory.push({ role: "assistant", content: answer });
        saveChat();
        maybeUpdateProfile();
      })
      .catch(function (err) {
        clearTimeout(timer);
        typing.remove();
        addMsg("bot", chatFailText(err));
      })
      .then(function () {
        chatBusy = false;
        $("chat-send").disabled = false;
        $("chat-input").focus();
      });
  }

  /* ---------- 备份 ---------- */
  function exportBackup() {
    var data = JSON.stringify({ version: 2, exported: new Date().toISOString(), cards: cards }, null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "小树英语复习本-" + L.todayStr() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var incoming = data.cards || data;
        if (!Array.isArray(incoming)) throw new Error("格式不对");
        var existing = {};
        cards.forEach(function (c) { existing[c.id] = true; });
        var added = 0;
        incoming.forEach(function (c) {
          if (!c || !c.question || !c.answer) return;
          if (c.id && existing[c.id]) return;
          cards.push({
            id: c.id || uid(), type: c.type || "其他", unit: c.unit || "",
            question: c.question, answer: c.answer, note: c.note || "",
            box: typeof c.box === "number" ? c.box : 0,
            due: c.due || L.todayStr(),
            created: c.created || L.todayStr()
          });
          added++;
        });
        save();
        updateStats();
        renderCards();
        toast("导入完成，新增 " + added + " 张");
      } catch (e) {
        toast("导入失败：文件格式不对");
      }
    };
    reader.readAsText(file);
  }

  /* ---------- 切页 ---------- */
  function switchTab(name) {
    ["review", "cards", "add", "chat", "board"].forEach(function (k) {
      var sec = $("tab-" + k);
      if (sec) sec.classList.toggle("active", k === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    document.body.classList.toggle("chat-mode", name === "chat");
    if (name === "cards") renderCards();
    if (name === "review") renderReviewIdle();
    if (name === "chat") {
      setTimeout(function () {
        var wrap = $("chat-messages");
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
      }, 50);
    }
    if (name === "board") renderBoard();
  }

  /* ---------- 语音 ---------- */
  // 浏览器自带的语音识别会把声音发到 Google，在中国大陆经常没有转写结果。
  // 这里在手机上录 16-bit PCM WAV，再交给 /api/transcribe。不要上传 webm。
  var TARGET_RATE = 16000;
  var MAX_RECORD_MS = 90000;
  var MIN_RECORD_SEC = 0.35;
  var ASR_WAIT_MS = 190000;

  function updateMic() {
    var btn = $("mic-btn");
    if (!btn) return;
    btn.classList.toggle("on", phase === "listening");
    btn.disabled = phase === "recognizing";
  }

  function setSpeechHint(text) {
    var hint = $("speech-hint-text");
    if (hint) hint.textContent = text;
  }

  function setPlaceholder(text) {
    var input = $("chat-input");
    if (input) input.placeholder = text;
  }

  function micSupported() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AudioCtx);
  }

  function speak(text) {
    if (!ttsOn || !window.speechSynthesis) return;
    var clean = String(text || "")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return;
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    var sentences = clean.match(/[^。！？!?\n]+[。！？!?]?/g) || [clean];
    var voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    sentences.forEach(function (s) {
      s = s.trim();
      if (!s) return;
      var cn = /[\u4e00-\u9fa5]/.test(s);
      var u = new SpeechSynthesisUtterance(s);
      u.lang = cn ? "zh-CN" : "en-US";
      u.rate = cn ? 1.0 : 0.9;
      var v = null;
      for (var i = 0; i < voices.length; i++) {
        var x = voices[i];
        if (cn ? /^zh/i.test(x.lang) : /^en/i.test(x.lang)) {
          v = x;
          if (/Tingting|Samantha|Alex|Google US English/i.test(x.name)) break;
        }
      }
      if (v) u.voice = v;
      try { window.speechSynthesis.speak(u); } catch (e) { /* ignore */ }
    });
  }

  function initSpeech() {
    if (!micSupported()) {
      var mic = $("mic-btn");
      if (mic) mic.classList.add("off");
      setSpeechHint("这个浏览器不能录音，用 Chrome 打开试试。");
    }
  }

  function toastMicError(err) {
    var name = (err && err.name) || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      toast("麦克风没权限，请在系统设置里允许浏览器使用麦克风");
      return;
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      toast("没找到麦克风");
      return;
    }
    toast("启动失败，再点一次");
  }

  function releaseMic() {
    micGen++;
    clearTimeout(recordTimer);
    recordTimer = null;
    if (recordProcessor) {
      try { recordProcessor.onaudioprocess = null; } catch (e) { /* ignore */ }
      try {
        if (recordProcessor.port) recordProcessor.port.onmessage = null;
      } catch (e) { /* ignore */ }
      try { recordProcessor.disconnect(); } catch (e) { /* ignore */ }
      recordProcessor = null;
    }
    if (recordSource) {
      try { recordSource.disconnect(); } catch (e) { /* ignore */ }
      recordSource = null;
    }
    if (recordMute) {
      try { recordMute.disconnect(); } catch (e) { /* ignore */ }
      recordMute = null;
    }
    if (recordStream) {
      var tracks = recordStream.getTracks();
      for (var i = 0; i < tracks.length; i++) {
        try { tracks[i].stop(); } catch (e) { /* ignore */ }
      }
      recordStream = null;
    }
    if (recordCtx) {
      var ctx = recordCtx;
      recordCtx = null;
      try { ctx.close(); } catch (e) { /* ignore */ }
    }
    recordChunks = [];
  }

  function ensureMic() {
    if (recordStream && recordCtx && recordCtx.state !== "closed") return Promise.resolve();
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    try {
      if (!recordCtx || recordCtx.state === "closed") recordCtx = new AudioCtx();
    } catch (e) {
      return Promise.reject(e);
    }
    var resume = recordCtx.resume();
    if (resume && typeof resume.catch === "function") resume.catch(function () { /* ignore */ });
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).catch(function (err) {
      if (err && (err.name === "OverconstrainedError" || err.name === "ConstraintNotSatisfiedError")) {
        return navigator.mediaDevices.getUserMedia({ audio: true });
      }
      throw err;
    }).then(function (stream) {
      if (!recordCtx || recordCtx.state === "closed") {
        var tracks = stream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (e) { /* ignore */ }
        }
        return;
      }
      recordStream = stream;
      if (recordCtx.state === "suspended" && recordCtx.resume) return recordCtx.resume();
    });
  }

  function mergeFloats(chunks) {
    var len = 0;
    for (var i = 0; i < chunks.length; i++) len += chunks[i].length;
    var out = new Float32Array(len);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out;
  }

  function resample(input, fromRate, toRate) {
    if (!input.length || !fromRate || fromRate === toRate) return input;
    if (fromRate > toRate) {
      var ratio = fromRate / toRate;
      var newLen = Math.floor(input.length / ratio);
      if (newLen < 1) return new Float32Array(0);
      var down = new Float32Array(newLen);
      var cursor = 0;
      for (var i = 0; i < newLen; i++) {
        var next = Math.min(input.length, Math.round((i + 1) * ratio));
        if (next <= cursor) next = Math.min(input.length, cursor + 1);
        var sum = 0;
        var count = next - cursor;
        for (var j = cursor; j < next; j++) sum += input[j];
        down[i] = count ? sum / count : 0;
        cursor = next;
      }
      return down;
    }
    var upLen = Math.max(1, Math.round(input.length * toRate / fromRate));
    var up = new Float32Array(upLen);
    var step = fromRate / toRate;
    for (var n = 0; n < upLen; n++) {
      var pos = n * step;
      var idx = Math.floor(pos);
      var frac = pos - idx;
      var a = input[idx] || 0;
      var b = input[Math.min(idx + 1, input.length - 1)] || 0;
      up[n] = a + (b - a) * frac;
    }
    return up;
  }

  function floatTo16(input) {
    var out = new Int16Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var s = input[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      else if (s !== s) s = 0;
      out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return out;
  }

  function encodeWav(samples, sampleRate) {
    var n = samples.length;
    var buffer = new ArrayBuffer(44 + n * 2);
    var view = new DataView(buffer);
    function writeStr(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, n * 2, true);
    var offset = 44;
    for (var i = 0; i < n; i++, offset += 2) view.setInt16(offset, samples[i], true);
    return new Blob([buffer], { type: "audio/wav" });
  }

  function resetSpeechUi() {
    phase = "idle";
    updateMic();
    setPlaceholder("打字，或点麦克风说…");
    setSpeechHint(IDLE_SPEECH_HINT);
  }

  function sendWav(blob) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) {
        try { ctrl.abort(); } catch (e) { /* ignore */ }
      }
    }, ASR_WAIT_MS);
    return fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: blob,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data || {} };
      });
    }).then(function (res) {
      clearTimeout(timer);
      if (res.status === 401) {
        var denied = new Error("需要访问码");
        denied.kind = "auth";
        throw denied;
      }
      var errText = String((res.data && res.data.error) || "");
      if (res.status === 504 || errText.indexOf("超时") >= 0) throw new Error("识别超时，再试一次");
      if (!res.ok) {
        if (errText.indexOf("没有收到音频") >= 0 || errText.indexOf("没录到") >= 0) {
          throw new Error("没录到声音，再试一次");
        }
        throw new Error("识别失败，再试一次");
      }
      return String(res.data.text || "").trim();
    }, function (err) {
      clearTimeout(timer);
      if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new Error("识别超时，再试一次");
      }
      if (err && err.message && (err.message.indexOf("再试一次") >= 0 || err.kind === "auth")) throw err;
      throw new Error("识别失败，再试一次");
    });
  }

  function finishRecording() {
    if (phase !== "listening") return;
    phase = "recognizing";
    clearTimeout(recordTimer);
    recordTimer = null;
    var chunks = recordChunks.slice();
    var fromRate = recordSampleRate || TARGET_RATE;
    releaseMic();
    updateMic();
    setPlaceholder("正在识别…");
    setSpeechHint("正在识别…");

    var wav = null;
    try {
      var merged = mergeFloats(chunks);
      var heardFor = fromRate ? merged.length / fromRate : 0;
      if (!merged.length || heardFor < MIN_RECORD_SEC) {
        shadowTarget = null;
        resetSpeechUi();
        toast("没录到声音，再试一次");
        return;
      }
      var samples = resample(merged, fromRate, TARGET_RATE);
      var maxSamples = TARGET_RATE * 110;
      if (samples.length > maxSamples) samples = samples.subarray(0, maxSamples);
      if (!samples.length) {
        shadowTarget = null;
        resetSpeechUi();
        toast("没录到声音，再试一次");
        return;
      }
      wav = encodeWav(floatTo16(samples), TARGET_RATE);
    } catch (e) {
      shadowTarget = null;
      resetSpeechUi();
      toast("识别失败，再试一次");
      return;
    }
    if (!wav || wav.size <= 44) {
      shadowTarget = null;
      resetSpeechUi();
      toast("没录到声音，再试一次");
      return;
    }
    if (wav.size > 8 * 1024 * 1024) {
      shadowTarget = null;
      resetSpeechUi();
      toast("识别失败，再试一次");
      return;
    }

    var keepShadow = shadowTarget;
    sendWav(wav).then(function (text) {
      resetSpeechUi();
      if (!text) {
        shadowTarget = null;
        toast("没听到说话，再试一次");
        return;
      }
      var input = $("chat-input");
      if (input) input.value = text;
      setSpeechHint("听到了：" + (text.length > 42 ? text.slice(0, 42) + "…" : text));
      if (keepShadow) {
        shadowTarget = keepShadow;
        handleShadowResult();
      }
    }).catch(function (err) {
      shadowTarget = null;
      resetSpeechUi();
      if (err && err.kind === "auth") return;
      toast((err && err.message) || "识别失败，再试一次");
    });
  }

  function beginCapture() {
    if (phase === "listening" || phase === "recognizing") return;
    if (!recordCtx || !recordStream || recordCtx.state === "closed") return;
    phase = "listening";
    recordChunks = [];
    recordSampleRate = recordCtx.sampleRate || TARGET_RATE;
    updateMic();
    setPlaceholder("我在听…");
    setSpeechHint(shadowTarget ? "跟读中，说完再点一次麦克风" : "我在听，说完再点一次麦克风");
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
    clearTimeout(recordTimer);
    recordTimer = setTimeout(function () {
      if (phase !== "listening") return;
      toast("说太久了，先识别到这里");
      finishRecording();
    }, MAX_RECORD_MS);

    var gen = micGen;
    var ctx = recordCtx;
    var stream = recordStream;

    function failStart() {
      if (gen !== micGen || phase !== "listening") return;
      shadowTarget = null;
      releaseMic();
      resetSpeechUi();
      toast("启动失败，再点一次");
    }

    function connect(node) {
      if (gen !== micGen || phase !== "listening") {
        try { node.disconnect(); } catch (e) { /* ignore */ }
        return;
      }
      var mute = ctx.createGain();
      mute.gain.value = 0;
      recordMute = mute;
      recordProcessor = node;
      recordSource.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
    }

    function useScriptProcessor() {
      var node;
      try { node = ctx.createScriptProcessor(4096, 1, 1); }
      catch (e) { failStart(); return; }
      node.onaudioprocess = function (e) {
        if (gen !== micGen || phase !== "listening") return;
        var ch = e.inputBuffer.getChannelData(0);
        if (!ch || !ch.length) return;
        recordChunks.push(new Float32Array(ch));
      };
      connect(node);
    }

    var source;
    try { source = ctx.createMediaStreamSource(stream); }
    catch (e) { failStart(); return; }
    recordSource = source;

    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === "function") {
      var blob = new Blob([PCM_WORKLET], { type: "application/javascript" });
      var url = URL.createObjectURL(blob);
      ctx.audioWorklet.addModule(url).then(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        if (gen !== micGen || phase !== "listening") return;
        try {
          var node = new AudioWorkletNode(ctx, "pcm-capture");
          node.port.onmessage = function (ev) {
            if (gen !== micGen || phase !== "listening") return;
            var data = ev.data;
            if (!data || !data.length) return;
            recordChunks.push(data instanceof Float32Array ? data : new Float32Array(data));
          };
          connect(node);
        } catch (e) {
          useScriptProcessor();
        }
      }).catch(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        if (gen !== micGen || phase !== "listening") return;
        useScriptProcessor();
      });
      return;
    }
    useScriptProcessor();
  }

  function toggleMic() {
    if (!micSupported()) {
      toast("这个浏览器不能录音，用 Chrome 打开试试");
      return;
    }
    if (phase === "recognizing") {
      toast("正在识别，请稍等");
      return;
    }
    if (phase === "listening") {
      finishRecording();
      return;
    }
    if (phase === "arming") {
      if (shadowTarget && recordStream && recordCtx && recordCtx.state !== "closed") {
        beginCapture();
        return;
      }
      if (!shadowTarget) {
        phase = "idle";
        releaseMic();
        updateMic();
        setPlaceholder("打字，或点麦克风说…");
        setSpeechHint(IDLE_SPEECH_HINT);
      }
      return;
    }
    shadowTarget = null;
    phase = "arming";
    updateMic();
    setSpeechHint("正在打开麦克风…");
    ensureMic().then(function () {
      if (phase !== "arming") {
        releaseMic();
        return;
      }
      beginCapture();
    }).catch(function (err) {
      if (phase === "arming") phase = "idle";
      releaseMic();
      updateMic();
      setSpeechHint(IDLE_SPEECH_HINT);
      toastMicError(err);
    });
  }

  function englishFromCard(c) {
    var texts = [c.question, c.answer, c.note];
    for (var i = 0; i < texts.length; i++) {
      var t = String(texts[i] || "").trim();
      if (/[a-zA-Z]/.test(t) && t.length >= 6) return t;
    }
    return null;
  }

  function startListeningAfterSpeech() {
    if (!shadowTarget || phase !== "arming") return;
    var speech = window.speechSynthesis;
    if (speech && (speech.speaking || speech.pending) && shadowWaited < 45) {
      shadowWaited += 0.3;
      setTimeout(startListeningAfterSpeech, 300);
      return;
    }
    shadowWaited = 0;
    setTimeout(function () {
      if (!shadowTarget || phase !== "arming") return;
      beginCapture();
    }, 280);
  }

  function startShadow() {
    var pool = [];
    cards.forEach(function (c) {
      var t = englishFromCard(c);
      if (t) pool.push(t);
    });
    if (!pool.length) {
      toast("先录一张带英文的卡片，再来跟读");
      return;
    }
    if (!micSupported()) {
      toast("这个浏览器不能录音，用 Chrome 打开试试");
      return;
    }
    if (phase !== "idle") {
      toast("等这次说完再跟读");
      return;
    }
    shadowTarget = pool[Math.floor(Math.random() * pool.length)];
    addMsg("bot", "跟我读这句：\n" + shadowTarget, null, false, "🎯 跟读");
    speak(shadowTarget);
    phase = "arming";
    shadowWaited = 0;
    updateMic();
    setSpeechHint("先听一遍，听完我会听你读");
    ensureMic().then(function () {
      if (!shadowTarget || phase !== "arming") {
        if (phase !== "listening" && phase !== "recognizing") releaseMic();
        return;
      }
      startListeningAfterSpeech();
    }).catch(function (err) {
      shadowTarget = null;
      if (phase === "arming") phase = "idle";
      releaseMic();
      updateMic();
      setSpeechHint(IDLE_SPEECH_HINT);
      toastMicError(err);
    });
  }

  function handleShadowResult() {
    var target = shadowTarget;
    shadowTarget = null;
    var said = $("chat-input").value.trim();
    $("chat-input").value = "";
    if (!said) {
      toast("没听清，再来一次");
      return;
    }
    var r = L.compareWords(target, said);
    addLog({
      kind: "pronounce",
      topic: target,
      result: r.score + "分",
      detail: r.missing.join(" ")
    });
    var cls = r.score >= 85 ? "good" : r.score >= 60 ? "mid" : "bad";
    var html = "目标：<b>" + esc(target) + "</b><br>你读的：" + esc(said)
      + '<span class="score-badge ' + cls + '">' + r.score + " 分</span>";
    if (r.missing.length) {
      html += "<br>没读出来的词：<span class=\"miss\">" + esc(r.missing.join(" ")) + "</span>";
    }
    addMsg("bot", html, null, true, "🎯 跟读");
    if (r.score < 95) askTutorAboutShadow(target, said, r);
  }

  function askTutorAboutShadow(target, said, r) {
    if (chatBusy) return;
    chatBusy = true;
    var typing = addMsg("bot", "听听发音…", "typing");
    var messages = [
      { role: "system", content: "你是英语发音小老师，给小树（三年级，剑桥二级）点评跟读。用简单中文，先夸一句，再指出一个最该注意的词，给一个口型小技巧。不超过 80 字。" },
      { role: "user", content: "目标句：" + target + "\n他读出来被识别成：" + said + "\n没对上的词：" + (r.missing.join(" ") || "无") }
    ];
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, CHAT_WAIT_MS);
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, max_tokens: 300 }),
      signal: ctrl.signal
    })
      .then(function (res) { return res.json(); })
      .then(function (d) {
        clearTimeout(timer);
        typing.remove();
        var answer = (d.content || "").trim();
        if (answer) {
          addMsg("bot", answer);
          speak(answer);
        }
      })
      .catch(function () {
        clearTimeout(timer);
        typing.remove();
      })
      .then(function () { chatBusy = false; });
  }

  /* ---------- 学习档案 ---------- */
  function renderProfileBar() {
    var el = $("profile-summary");
    if (el) {
      el.textContent = profile.summary
        ? profile.summary.slice(0, 36) + (profile.summary.length > 36 ? "…" : "")
        : "还没有档案，多聊几次会自动生成";
    }
    var box = $("profile-text");
    if (box) box.textContent = profile.summary || "还没有档案。和小树多聊几次，或者点「根据聊天更新」。";
    var up = $("profile-updated");
    if (up) up.textContent = profile.updated ? "更新于 " + String(profile.updated).slice(0, 10) : "";
  }

  function updateProfile(auto) {
    if (profileBusy) return;
    if (chatHistory.length < 2) {
      if (!auto) toast("还没聊几句，先聊聊");
      return;
    }
    profileBusy = true;
    if (!auto) toast("正在更新档案…");
    var recent = chatHistory.slice(-16).map(function (m) {
      return (m.role === "user" ? "小树：" : "老师：") + m.content;
    }).join("\n");
    var messages = [
      { role: "system", content: "你在维护一个三年级学生的英语学习档案。根据现有档案和最近对话，更新档案。只写事实：学过的语法和单词、掌握程度、常犯错误、学习习惯。没有新信息就保持原样。用中文，200字以内，不要加标题。" },
      { role: "user", content: "现有档案：\n" + (profile.summary || "（空）") + "\n\n最近对话：\n" + recent }
    ];
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, max_tokens: 700 })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var text = (d.content || "").trim();
        if (!text) return;
        profile.summary = text;
        profile.updated = new Date().toISOString();
        renderProfileBar();
        fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary: text })
        }).catch(function () {});
        if (!auto) toast("档案更新好了");
      })
      .catch(function () { if (!auto) toast("更新失败，稍后再试"); })
      .then(function () { profileBusy = false; });
  }

  function maybeUpdateProfile() {
    var n = chatHistory.filter(function (m) { return m.role === "user"; }).length;
    if (n > 0 && n % 6 === 0) updateProfile(true);
  }

  /* ---------- 看板 ---------- */
  function weekStart() {
    var d = new Date();
    var day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return L.todayStr(d);
  }

  function renderBoard() {
    var ws = reportWeek || weekStart();
    var we = L.addDays(ws, 6);
    if ($("board-range")) $("board-range").textContent = weekRangeLabel(ws);

    var weekLogs = logs.filter(function (l) {
      var d = l.ts && l.ts.slice(0, 10);
      return d >= ws && d <= we;
    });
    var reviewLogs = weekLogs.filter(function (l) { return l.kind === "review"; });
    var forget = reviewLogs.filter(function (l) { return l.result === "忘了"; }).length;
    var good = reviewLogs.filter(function (l) { return l.result === "熟练"; }).length;
    var pronounce = weekLogs.filter(function (l) { return l.kind === "pronounce"; });
    var chatLogs = weekLogs.filter(function (l) { return l.kind === "chat"; });

    var st = weekStats(reportWeek || weekStart());

    if ($("board-stats")) {
      $("board-stats").innerHTML =
        '<div class="board-stat"><b>' + st.weekPoints + '</b><span>本周积分</span></div>' +
        '<div class="board-stat"><b>¥' + st.weekMoney + '</b><span>本周奖金</span></div>' +
        '<div class="board-stat"><b>' + reviewLogs.length + '</b><span>本周复习次数</span></div>' +
        '<div class="board-stat"><b>' + good + '</b><span>一次就对</span></div>' +
        '<div class="board-stat"><b>' + forget + '</b><span>反复错的</span></div>' +
        '<div class="board-stat"><b>' + pronounce.length + '</b><span>跟读次数</span></div>' +
        '<div class="board-stat"><b>' + chatLogs.length + '</b><span>提问次数</span></div>';
    }
    if ($("points-hint")) {
      $("points-hint").textContent = st.continuous
        ? "本周每天都打卡，每个积分按 2 元算。"
        : "本周中间断过，前面已得的积分按 1 元算；从明天起连着打卡，又能按 2 元算。";
    }

    var wrongLogs = weekLogs.filter(function (l) { return l.kind === "wrong"; });
    var wrongMap = {};
    wrongLogs.forEach(function (l) {
      var k = (l.type || "") + "|" + (l.topic || "");
      if (!wrongMap[k]) {
        wrongMap[k] = { topic: l.topic || "", type: l.type || "", answer: l.detail || "", wrong: [], count: 0 };
      }
      wrongMap[k].count++;
      if (l.result && wrongMap[k].wrong.indexOf(l.result) < 0) wrongMap[k].wrong.push(l.result);
    });
    var weak = Object.keys(wrongMap).map(function (k) { return wrongMap[k]; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 10);
    if ($("board-weak")) {
      $("board-weak").innerHTML = weak.length
        ? weak.map(function (w) {
            return '<div class="board-wrong">' +
              '<div class="board-wrong-head">' + esc(w.topic) +
              ' <span class="miss">错 ' + w.count + ' 次</span></div>' +
              '<div class="board-wrong-body" style="display:none">正确答案：' + esc(w.answer) +
              (w.wrong.length ? '<br>错选过：' + esc(w.wrong.join("、")) : '') +
              '<br><span class="muted">点这张卡收起</span></div></div>';
          }).join("")
        : '<div class="board-empty">本周没有错题，不错。</div>';
    }

    var pron = pronounce.slice(-8).reverse();
    if ($("board-pronounce")) {
      $("board-pronounce").innerHTML = pron.length
        ? pron.map(function (l) {
            return '<div class="board-item">' + esc(l.topic) + ' <span class="miss">' + esc(l.result) + '</span>' +
              (l.detail ? '<br><span class="miss">没读出来：' + esc(l.detail) + '</span>' : '') + '</div>';
          }).join("")
        : '<div class="board-empty">还没跟读记录，去聊天页点「跟读练发音」。</div>';
    }

    var qCount = {};
    chatLogs.forEach(function (l) { qCount[l.topic] = (qCount[l.topic] || 0) + 1; });
    var qs = Object.keys(qCount).map(function (k) { return { q: k, n: qCount[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 5);
    if ($("board-questions")) {
      $("board-questions").innerHTML = qs.length
        ? qs.map(function (x) {
            return '<div class="board-item">' + esc(x.q) + (x.n > 1 ? ' <span class="muted">×' + x.n + '</span>' : '') + '</div>';
          }).join("")
        : '<div class="board-empty">本周还没提问。</div>';
    }

    renderReportSection();

    var tbox = $("tunnel-box");
    if (tbox) {
      if (tunnelUrl) {
        tbox.innerHTML = '电脑开着就能用：<br><a href="' + esc(tunnelUrl) + '" target="_blank" rel="noreferrer">' + esc(tunnelUrl) + '</a>' + (accessCode ? '<br>访问码：<b>' + esc(accessCode) + '</b>' : '') + '<br><span class="muted">临时地址，重启电脑后会变，以这里显示的为准。</span>';
      } else {
        tbox.innerHTML = '<span class="muted">没有临时隧道。本机开着 cloudflared 时，地址会出现在这里；部署到 Cloudflare 后，直接打开站点自己的地址。</span>';
      }
    }
  }

  function parseReport(text) {
    var s = String(text || "").trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    var start = s.indexOf("{"), end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        var obj = JSON.parse(s.slice(start, end + 1));
        var summary = String(obj.summary || "").trim();
        var tasks = Array.isArray(obj.tasks) ? obj.tasks.filter(function (t) {
          return t && t.title;
        }).map(function (t) {
          return { title: String(t.title).slice(0, 200), type: String(t.type || "").slice(0, 20), done: false };
        }) : [];
        if (summary) return { summary: summary, tasks: tasks };
      } catch (e) { /* fallthrough */ }
    }
    return { summary: s, tasks: [] };
  }

  function currentReport() {
    for (var i = 0; i < reports.length; i++) {
      if (reports[i].week === reportWeek) return reports[i];
    }
    return null;
  }

  function weekRangeLabel(week) {
    var end = L.addDays(week, 6);
    return week.slice(5).replace("-", "/") + " - " + end.slice(5).replace("-", "/");
  }

  function isPhone() {
    var ua = navigator.userAgent || "";
    if (!/iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua)) return false;
    if (/iPad|Tablet/.test(ua)) return false;
    return true;
  }

  function canManage() {
    return isPhone() || /[?&]admin=1/.test(location.search);
  }

  function canGenerate() {
    return canManage();
  }

  function renderReportTasks() {
    var box = $("board-tasks");
    if (!box) return;
    var r = currentReport();
    var tasks = r && Array.isArray(r.tasks) ? r.tasks : [];
    if (!tasks.length) {
      box.innerHTML = '<div class="board-empty">这一周还没有改进任务。</div>';
      return;
    }
    box.innerHTML = tasks.map(function (t, i) {
      return '<div class="task-item' + (t.done ? ' done' : '') + '">' +
        '<span class="task-item-title">' + esc(t.title) + '</span>' +
        '<button class="btn small" data-fix="' + i + '">去订正</button></div>';
    }).join("");
  }

  function renderReportSection() {
    var r = currentReport();
    var thisWeek = weekStart();
    if (!reportWeek) reportWeek = thisWeek;

    if ($("week-label")) $("week-label").textContent = weekRangeLabel(reportWeek);
    if ($("board-range")) $("board-range").textContent = weekRangeLabel(reportWeek || thisWeek);
    if ($("board-report")) {
      $("board-report").textContent = r ? r.text : "这一周还没有生成总结。";
    }
    renderReportTasks();

    var canGen = canGenerate() && reportWeek === thisWeek;
    if ($("board-gen")) $("board-gen").style.display = canGen ? "block" : "none";
    var hint = $("board-gen-hint");
    if (hint) {
      if (canGen) hint.textContent = "";
      else if (reportWeek !== thisWeek) hint.textContent = "历史周只读，只能生成本周。";
      else hint.textContent = "为了不让小朋友自己生成，周总结只能在手机上操作。";
    }
    if ($("week-next")) $("week-next").disabled = reportWeek >= thisWeek;
  }

  function generateReport() {
    if (reportBusy) return;
    if (!canGenerate()) { toast("周总结只能在手机上生成"); return; }
    var week = reportWeek || weekStart();
    if (week !== weekStart()) { toast("只能生成本周"); return; }

    reportBusy = true;
    var btn = $("board-gen");
    if (btn) btn.disabled = true;
    if ($("board-report")) $("board-report").textContent = "正在根据本周记录生成…";

    var ws = weekStart();
    var weekLogs = logs.filter(function (l) { return l.ts && l.ts.slice(0, 10) >= ws; });
    var linesText = weekLogs.slice(-60).map(function (l) {
      return l.kind + " | " + l.topic + " | " + l.result + (l.detail ? " | " + l.detail : "");
    }).join("\n");
    var messages = [
      { role: "system", content: "你是英语学习顾问。根据一周的记录，给三年级学生小树写一份 120 字以内的中文评估，并给出 3 到 5 个具体可执行的改进任务。评估里要按单词、语法、例句分开说：哪类一次就选对得多，哪类反复错得多。只输出 JSON，不要解释：{\"summary\":\"评估文字\",\"tasks\":[{\"title\":\"具体任务，比如：复习一般过去时否定句 did not + 动词原形，做3题\",\"type\":\"语法|单词|发音|阅读\"}]}。任务要针对记录里的薄弱点，能直接去做。" },
      { role: "user", content: "学习档案：\n" + (profile.summary || "暂无") + "\n\n本周记录：\n" + (linesText || "暂无") }
    ];
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, max_tokens: 1200 })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var raw = (d.content || "").trim();
        if (!raw) throw new Error("空结果");
        var parsed = parseReport(raw);
        var entry = {
          week: week,
          text: parsed.summary,
          tasks: parsed.tasks,
          updated: new Date().toISOString()
        };
        reports = reports.filter(function (x) { return x.week !== week; });
        reports.push(entry);
        reports.sort(function (a, b) { return a.week < b.week ? 1 : -1; });
        if ($("board-report")) $("board-report").textContent = entry.text;
        renderReportTasks();
        fetch("/api/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry)
        }).catch(function () {});
        toast("周总结和改进任务生成好了");
      })
      .catch(function () {
        if ($("board-report")) $("board-report").textContent = "生成失败，稍后再试。";
      })
      .then(function () {
        reportBusy = false;
        if (btn) btn.disabled = false;
      });
  }

  function resetToday() {
    var t = L.todayStr();
    var todayLogs = logs.filter(function (l) {
      return l.kind === "review" && l.ts && l.ts.slice(0, 10) === t;
    });
    if (!todayLogs.length) { toast("今天还没有复习记录"); return; }
    if (!confirm("确定重置今天的打卡吗？今天的复习记录会清掉，复习过的卡片会回到今天。")) return;

    var keys = {};
    todayLogs.forEach(function (l) {
      keys[(l.type || "其他") + "|" + (l.topic || "")] = true;
    });
    cards.forEach(function (c) {
      if (keys[(c.type || "其他") + "|" + (c.question || "")]) {
        c.due = t;
        c.box = Math.max(0, (c.box || 0) - 1);
      }
    });

    logs = logs.filter(function (l) {
      return !(l.kind === "review" && l.ts && l.ts.slice(0, 10) === t);
    });

    save();
    try { localStorage.setItem(LOGS_KEY, JSON.stringify(logs)); } catch (e) { /* ignore */ }
    if (window.fetch) {
      fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logs: logs })
      }).catch(function () {});
    }

    updateStats();
    renderCards();
    renderReviewIdle();
    renderBoard();
    toast("今天的打卡已重置");
  }

  /* ---------- 每日目标 ---------- */
  function openGoalModal() {
    $("goal-total").value = settings.dailyGoal || 10;
    ["单词", "语法", "例句", "其他"].forEach(function (t) {
      $("goal-" + t).value = (settings.typeGoals && settings.typeGoals[t]) || 0;
    });
    $("goal-modal").classList.add("show");
  }

  function saveGoalSettings() {
    var next = {
      dailyGoal: Math.max(1, Math.min(100, Number($("goal-total").value) || 10)),
      typeGoals: {}
    };
    ["单词", "语法", "例句", "其他"].forEach(function (t) {
      next.typeGoals[t] = Math.max(0, Math.min(50, Number($("goal-" + t).value) || 0));
    });
    settings = next;
    if (window.fetch) {
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next)
      }).catch(function () {});
    }
    $("goal-modal").classList.remove("show");
    renderReviewIdle();
    toast("每日目标已更新");
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
      b.addEventListener("click", function () { switchTab(b.getAttribute("data-tab")); });
    });

    Array.prototype.forEach.call(document.querySelectorAll("#filter-row button"), function (b) {
      b.addEventListener("click", function () {
        currentFilter = b.getAttribute("data-filter");
        Array.prototype.forEach.call(document.querySelectorAll("#filter-row button"), function (x) {
          x.classList.toggle("active", x === b);
        });
        renderCards();
      });
    });

    $("review-board").addEventListener("click", function (e) {
      var el = e.target;
      while (el && el !== this) {
        if (el.id === "review-start") { startReview(); return; }
        if (el.id === "goal-open") { openGoalModal(); return; }
        if (el.id === "reset-today") { resetToday(); return; }
        if (el.getAttribute && el.getAttribute("data-type")) {
          startReview(el.getAttribute("data-type"));
          return;
        }
        el = el.parentNode;
      }
    });
    $("review-submit").addEventListener("click", submitAnswer);
    $("review-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
    });

    $("review-back").addEventListener("click", function () {
      reviewQueue = [];
      reviewIndex = 0;
      renderReviewIdle();
    });

    $("save-card").addEventListener("click", saveCard);
    $("clear-form").addEventListener("click", clearForm);

    $("pick-photo").addEventListener("click", pickPhoto);
    $("photo-input").addEventListener("change", onPhotoPicked);
    $("pick-pdf").addEventListener("click", function () { $("pdf-input").click(); });
    $("pdf-input").addEventListener("change", onPhotoPicked);
    $("ai-gen").addEventListener("click", aiGenerate);

    $("export-btn").addEventListener("click", exportBackup);
    $("import-btn").addEventListener("click", function () { $("import-file").click(); });
    $("import-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importBackup(f);
      e.target.value = "";
    });

    $("chat-send").addEventListener("click", sendChat);
    $("chat-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); sendChat(); }
    });
    Array.prototype.forEach.call(document.querySelectorAll("#chat-hints button[data-q]"), function (b) {
      b.addEventListener("click", function () {
        $("chat-input").value = b.getAttribute("data-q");
        sendChat();
      });
    });

    $("mic-btn").addEventListener("click", toggleMic);
    $("tts-toggle").addEventListener("click", function () {
      ttsOn = !ttsOn;
      this.classList.toggle("off", !ttsOn);
      this.textContent = ttsOn ? "🔊" : "🔇";
      if (!ttsOn && window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      }
      toast(ttsOn ? "回答会朗读" : "已关掉朗读");
    });
    $("shadow-btn").addEventListener("click", startShadow);

    $("profile-btn").addEventListener("click", function () {
      renderProfileBar();
      $("profile-modal").classList.add("show");
    });
    $("profile-close").addEventListener("click", function () {
      $("profile-modal").classList.remove("show");
    });
    $("profile-refresh").addEventListener("click", function () { updateProfile(false); });
    $("profile-modal").addEventListener("click", function (e) {
      if (e.target === this) this.classList.remove("show");
    });
    $("access-save").addEventListener("click", function () {
      var code = $("access-input").value.trim();
      if (!code) return;
      localStorage.setItem(ACCESS_KEY, code);
      location.reload();
    });

    $("edit-save").addEventListener("click", saveEdit);
    $("edit-close").addEventListener("click", function () {
      $("edit-modal").classList.remove("show");
    });
    $("edit-modal").addEventListener("click", function (e) {
      if (e.target === this) this.classList.remove("show");
    });

    $("goal-save").addEventListener("click", saveGoalSettings);
    $("goal-close").addEventListener("click", function () {
      $("goal-modal").classList.remove("show");
    });
    $("goal-modal").addEventListener("click", function (e) {
      if (e.target === this) this.classList.remove("show");
    });

    $("board-gen").addEventListener("click", generateReport);
    $("board-weak").addEventListener("click", function (e) {
      var el = e.target;
      while (el && el !== this) {
        if (el.classList && el.classList.contains("board-wrong")) {
          el.classList.toggle("open");
          var body = el.querySelector(".board-wrong-body");
          if (body) body.style.display = el.classList.contains("open") ? "block" : "none";
          return;
        }
        el = el.parentNode;
      }
    });
    $("week-prev").addEventListener("click", function () {
      reportWeek = L.addDays(reportWeek || weekStart(), -7);
      renderBoard();
    });
    $("week-next").addEventListener("click", function () {
      var next = L.addDays(reportWeek || weekStart(), 7);
      if (next <= weekStart()) { reportWeek = next; renderBoard(); }
    });
    $("board-tasks").addEventListener("click", function (e) {
      var el = e.target;
      while (el && el !== this) {
        if (el.getAttribute && el.getAttribute("data-fix") !== null) {
          var i = Number(el.getAttribute("data-fix"));
          var cur = currentReport();
          var t = cur && cur.tasks ? cur.tasks[i] : null;
          if (t) {
            switchTab("chat");
            $("chat-input").value = "我想订正这个任务：" + t.title + "。请出 3 道针对性的练习题，我做完你帮我改。";
            sendChat();
          }
          return;
        }
        el = el.parentNode;
      }
    });


  }

  load();
  loadLogsLocal();
  reportWeek = weekStart();
  bind();
  initSpeech();
  updateStats();
  renderReviewIdle();
  renderCards();
  renderChatHistory();
  renderProfileBar();
  renderBoard();
  setBubble();

  var initialTab = String(location.hash || "").replace("#", "");
  if (["review", "cards", "add", "chat"].indexOf(initialTab) >= 0) {
    switchTab(initialTab);
  }

  loadRemote().then(function () {
    updateStats();
    renderReviewIdle();
    renderCards();
  });

  setInterval(function () {
    checkDayChange();
    syncCards(true);
  }, 30000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) syncCards(true);
  });
})();
