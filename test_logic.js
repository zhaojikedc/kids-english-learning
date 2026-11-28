/* 核心逻辑自测 */
"use strict";
const assert = require("assert");
const L = require("./public/logic.js");

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log("PASS " + name);
}

ok("addDays 跨月", () => {
  assert.strictEqual(L.addDays("2026-11-30", 1), "2026-12-01");
  assert.strictEqual(L.addDays("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(L.addDays("2026-11-15", 7), "2026-11-22");
});

ok("intervalFor 边界", () => {
  assert.strictEqual(L.intervalFor(0), 1);
  assert.strictEqual(L.intervalFor(6), 60);
  assert.strictEqual(L.intervalFor(99), 60);
  assert.strictEqual(L.intervalFor(-5), 1);
});

ok("gradeCard 忘了 → 明天重来", () => {
  const r = L.gradeCard({ box: 4 }, 0, "2026-11-15");
  assert.deepStrictEqual(r, { box: 0, due: "2026-11-16" });
});

ok("gradeCard 有点印象 → 盒子不动、按当前间隔", () => {
  const r = L.gradeCard({ box: 2 }, 1, "2026-11-15");
  assert.deepStrictEqual(r, { box: 2, due: "2026-11-19" });
});

ok("gradeCard 熟练 → 升一盒", () => {
  const r = L.gradeCard({ box: 0 }, 2, "2026-11-15");
  assert.deepStrictEqual(r, { box: 1, due: "2026-11-17" });
});

ok("gradeCard 封顶", () => {
  const r = L.gradeCard({ box: 6 }, 2, "2026-11-15");
  assert.deepStrictEqual(r, { box: 6, due: "2027-01-14" });
});

ok("isDue 到期判断", () => {
  assert.strictEqual(L.isDue({ due: "2026-11-15" }, "2026-11-15"), true);
  assert.strictEqual(L.isDue({ due: "2026-11-14" }, "2026-11-15"), true);
  assert.strictEqual(L.isDue({ due: "2026-11-16" }, "2026-11-15"), false);
});

ok("tokenize 中英混合", () => {
  const t = L.tokenize("过去式 past tense 怎么变");
  assert.ok(t.includes("past"));
  assert.ok(t.includes("过去"));
});

ok("searchCards 命中", () => {
  const cards = [
    { question: "过去式的否定句怎么变？", answer: "主语 + didn't + 动词原形", type: "语法" },
    { question: "apple 是什么意思", answer: "苹果", type: "单词" },
    { question: "现在进行时怎么用", answer: "be + doing", type: "语法" }
  ];
  const hit = L.searchCards(cards, "过去式怎么变", 3);
  assert.ok(hit.length >= 1);
  assert.strictEqual(hit[0].question, "过去式的否定句怎么变？");

  const miss = L.searchCards(cards, "今天天气", 3);
  assert.strictEqual(miss.length, 0);
});

ok("searchCards 空查询不炸", () => {
  assert.deepStrictEqual(L.searchCards([], "", 3), []);
  assert.deepStrictEqual(L.searchCards(null, "过去式", 3), []);
});

ok("compareWords 完全一致 100 分", () => {
  const r = L.compareWords("The cat is sleeping", "the cat is sleeping");
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.missing.length, 0);
});

ok("compareWords 漏词能指出来", () => {
  const r = L.compareWords("The cat is sleeping on the sofa", "the cat sleeping on sofa");
  assert.ok(r.score > 60 && r.score < 100, "score=" + r.score);
  assert.ok(r.missing.includes("is"));
});

ok("compareWords 读错词能指出来", () => {
  const r = L.compareWords("I went to school", "I want to school");
  assert.ok(r.missing.includes("went"));
});

ok("compareWords 空目标不炸", () => {
  const r = L.compareWords("", "abc");
  assert.strictEqual(r.score, 0);
});

ok("speechStep 停顿后结束，按住时不结束，并给出中间结果", () => {
  assert.strictEqual(L.speechStep({
    heard: true,
    elapsedMs: 2000,
    silentForMs: L.SPEECH_SILENCE_MS,
    audioSec: 1.2,
    hold: false
  }), "final");
  assert.strictEqual(L.speechStep({
    heard: true,
    elapsedMs: 2000,
    silentForMs: L.SPEECH_SILENCE_MS + 500,
    audioSec: 1.2,
    hold: true
  }), "wait");
  assert.strictEqual(L.speechStep({
    heard: true,
    elapsedMs: 1000,
    silentForMs: 100,
    audioSec: 1,
    unsentSec: L.SPEECH_PARTIAL_SEC,
    inflight: false,
    sentOnce: false
  }), "partial");
  assert.strictEqual(L.speechStep({
    heard: true,
    elapsedMs: 1000,
    silentForMs: 100,
    audioSec: 1,
    unsentSec: L.SPEECH_PARTIAL_SEC,
    inflight: true,
    sentOnce: false
  }), "wait");
  assert.strictEqual(L.speechStep({
    heard: false,
    elapsedMs: L.SPEECH_NO_SPEECH_MS,
    silentForMs: L.SPEECH_NO_SPEECH_MS
  }), "no-speech");
  assert.strictEqual(L.speechStep({
    heard: true,
    hold: true,
    elapsedMs: L.SPEECH_MAX_MS,
    audioSec: 3,
    silentForMs: 0
  }), "final");
});

console.log("\n全部通过：" + pass + " 项");
