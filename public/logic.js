/* 小树英语复习本 · 核心逻辑（浏览器与 Node 共用，便于自测） */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.XYLogic = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var INTERVALS = [1, 2, 4, 7, 15, 30, 60];
  var MAX_BOX = INTERVALS.length - 1;

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function fmtDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function todayStr(d) { return fmtDate(d || new Date()); }

  function parseDate(s) {
    var p = String(s || "").split("-");
    return new Date(Number(p[0]) || 1970, (Number(p[1]) || 1) - 1, Number(p[2]) || 1);
  }

  function addDays(dateStr, days) {
    var d = parseDate(dateStr);
    d.setDate(d.getDate() + Number(days || 0));
    return fmtDate(d);
  }

  function intervalFor(box) {
    var b = Math.max(0, Math.min(MAX_BOX, Number(box) || 0));
    return INTERVALS[b];
  }

  function normaliseBox(card) {
    var b = card && typeof card.box === "number" ? card.box : 0;
    return Math.max(0, Math.min(MAX_BOX, b | 0));
  }

  // grade: 0 忘了, 1 有点印象, 2 熟练
  function gradeCard(card, grade, today) {
    var box = normaliseBox(card);
    var t = today || todayStr();
    var newBox, due;
    if (grade <= 0) {
      newBox = 0;
      due = addDays(t, 1);
    } else if (grade === 1) {
      newBox = box;
      due = addDays(t, intervalFor(box));
    } else {
      newBox = Math.min(MAX_BOX, box + 1);
      due = addDays(t, intervalFor(newBox));
    }
    return { box: newBox, due: due };
  }

  function isDue(card, today) {
    return !!card && !!card.due && card.due <= (today || todayStr());
  }

  var CN_STOP = {
    "的": 1, "了": 1, "是": 1, "我": 1, "你": 1, "他": 1, "她": 1, "它": 1,
    "这": 1, "那": 1, "什么": 1, "怎么": 1, "哪些": 1, "有": 1, "吗": 1,
    "呢": 1, "吧": 1, "和": 1, "与": 1, "在": 1, "会": 1, "能": 1, "要": 1,
    "想": 1, "请问": 1, "一下": 1, "我们": 1, "他们": 1, "这个": 1, "那个": 1
  };

  // 中文取二字滑窗，英文取单词
  function tokenize(text) {
    var s = String(text || "").toLowerCase();
    var out = (s.match(/[a-z][a-z'\-]*/g) || []);
    var cn = s.replace(/[^\u4e00-\u9fa5]+/g, " ").trim();
    if (cn) {
      cn.split(/\s+/).forEach(function (p) {
        if (!p) return;
        if (p.length === 1) { out.push(p); return; }
        for (var i = 0; i < p.length - 1; i++) out.push(p.substr(i, 2));
      });
    }
    return out;
  }

  function scoreCard(card, tokens) {
    if (!card || !tokens || !tokens.length) return 0;
    var hay = tokenize(
      (card.question || "") + " " + (card.answer || "") + " " +
      (card.unit || "") + " " + (card.note || "") + " " + (card.type || "")
    );
    var set = {};
    hay.forEach(function (t) { set[t] = (set[t] || 0) + 1; });
    var score = 0;
    tokens.forEach(function (t) {
      if (CN_STOP[t] || t.length < 1) return;
      if (set[t]) score += t.length >= 2 ? 3 : 1;
    });
    return score;
  }

  function searchCards(cards, query, limit) {
    var tokens = tokenize(query);
    var scored = [];
    (cards || []).forEach(function (c) {
      var s = scoreCard(c, tokens);
      if (s > 0) scored.push({ card: c, score: s });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 3).map(function (x) { return x.card; });
  }

  // 跟读对比：目标句 vs 识别出的句子，按词对齐给分
  function compareWords(target, said) {
    function norm(s) {
      return String(s || "").toLowerCase()
        .replace(/[^a-z0-9'\s]/g, " ")
        .split(/\s+/).filter(Boolean);
    }
    var t = norm(target);
    var s = norm(said);
    var n = t.length, m = s.length;
    if (!n) return { score: 0, matched: 0, targetCount: 0, missing: [], extra: [], targetWords: [], saidWords: s };

    var dp = [];
    for (var i = 0; i <= n; i++) {
      dp[i] = [];
      for (var j = 0; j <= m; j++) dp[i][j] = 0;
    }
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        dp[i][j] = t[i - 1] === s[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var lcs = dp[n][m];

    var matchedFlags = new Array(n);
    for (i = 0; i < n; i++) matchedFlags[i] = false;
    i = n; j = m;
    while (i > 0 && j > 0) {
      if (t[i - 1] === s[j - 1]) { matchedFlags[i - 1] = true; i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }

    var missing = [];
    for (i = 0; i < n; i++) if (!matchedFlags[i]) missing.push(t[i]);

    var score = (n + m) === 0 ? 0 : Math.round((2 * lcs / (n + m)) * 100);
    return {
      score: score,
      matched: lcs,
      targetCount: n,
      missing: missing,
      extra: [],
      targetWords: t,
      saidWords: s
    };
  }

  return {
    INTERVALS: INTERVALS,
    MAX_BOX: MAX_BOX,
    todayStr: todayStr,
    addDays: addDays,
    intervalFor: intervalFor,
    normaliseBox: normaliseBox,
    gradeCard: gradeCard,
    isDue: isDue,
    tokenize: tokenize,
    scoreCard: scoreCard,
    searchCards: searchCards,
    compareWords: compareWords
  };
});
