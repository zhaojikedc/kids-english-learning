"use strict";

/*
 * 语音转写只做两件事：检查浏览器送来的 WAV，再原样转发给 DeepSeek ASR。
 * Worker 免费额度只有大约 10ms CPU，这里不能解码或转码。
 * 官方只收 16-bit PCM WAV 或 Ogg Opus：https://api-docs.deepseek.com/guides/asr/
 */

const ASR_URL = "https://api.deepseek.com/v1/tools/asr";
const ASR_TIMEOUT_MS = 180000;
const WAV_MAX_BYTES = 8 * 1024 * 1024;
const WAV_MAX_SECONDS = 120;
const WAV_RATES = {
  8000: true,
  16000: true,
  22050: true,
  24000: true,
  32000: true,
  44100: true,
  48000: true
};

function asBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function ascii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function validateWav(value) {
  const bytes = asBytes(value);
  if (!bytes || !bytes.byteLength) return { ok: false, status: 400, error: "没有收到音频" };
  if (bytes.byteLength > WAV_MAX_BYTES) return { ok: false, status: 413, error: "音频太大" };
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return { ok: false, status: 400, error: "音频格式不对" };
  }

  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = u32(bytes, offset + 4);
    const start = offset + 8;
    if (size > bytes.byteLength - start) return { ok: false, status: 400, error: "音频格式不对" };
    if (id === "fmt ") {
      if (size < 16) return { ok: false, status: 400, error: "音频格式不对" };
      format = u16(bytes, start);
      channels = u16(bytes, start + 2);
      rate = u32(bytes, start + 4);
      bits = u16(bytes, start + 14);
    } else if (id === "data" && !dataSize) {
      dataSize = size;
    }
    const padded = size + (size % 2);
    offset = start + padded;
  }

  if (format !== 1 || bits !== 16 || (channels !== 1 && channels !== 2) || !WAV_RATES[rate] || !dataSize) {
    return { ok: false, status: 400, error: "音频格式不对" };
  }
  const duration = dataSize / (rate * channels * (bits / 8));
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, status: 400, error: "没有收到音频" };
  if (duration > WAV_MAX_SECONDS) return { ok: false, status: 400, error: "音频超过 120 秒" };
  return { ok: true, sampleRate: rate, channels: channels, duration: duration };
}

function upstreamError(status) {
  if (status === 408 || status === 504) return "识别超时";
  if (status === 413) return "音频太大";
  if (status === 429) return "识别太忙，稍后再试";
  if (status === 503) return "识别服务忙，稍后再试";
  if (status === 400) return "音频格式不对";
  return "识别失败";
}

async function transcribe(apiKey, value, timeoutMs) {
  const bytes = asBytes(value);
  if (!bytes || !bytes.byteLength) return { ok: false, status: 400, text: "", error: "没有收到音频" };
  const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
  const form = new FormData();
  const blob = new Blob([body], { type: "audio/wav" });
  form.append("file", blob, "speech.wav");

  let res;
  try {
    res = await fetch(ASR_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey },
      body: form,
      signal: AbortSignal.timeout(timeoutMs || ASR_TIMEOUT_MS)
    });
  } catch (err) {
    const name = err && err.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    console.error(JSON.stringify({
      message: "asr request failed",
      error: timedOut ? "timeout" : (err instanceof Error ? err.message : String(err))
    }));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      text: "",
      error: timedOut ? "识别超时" : "识别失败"
    };
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    if (res.body && typeof res.body.cancel === "function") {
      try { await res.body.cancel(); } catch (cancelErr) { /* already consumed */ }
    }
    return { ok: false, status: 502, text: "", error: "识别失败" };
  }

  if (!res.ok) {
    console.error(JSON.stringify({ message: "asr upstream error", status: res.status }));
    return { ok: false, status: res.status || 502, text: "", error: upstreamError(res.status) };
  }

  const text = data && typeof data.text === "string" ? data.text : "";
  return { ok: true, status: 200, text: text, error: "" };
}

module.exports = {
  ASR_URL,
  ASR_TIMEOUT_MS,
  WAV_MAX_BYTES,
  WAV_MAX_SECONDS,
  validateWav,
  transcribe
};
