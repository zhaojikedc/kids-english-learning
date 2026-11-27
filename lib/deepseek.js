"use strict";

async function complete(apiKey, payload, timeoutMs) {
  // 官方接口省略 thinking 时默认先思考。家庭复习是非流式，思考会拖过页面等待，所以一律关掉。
  const body = Object.assign({}, payload, {
    thinking: { type: "disabled" }
  });
  let res;
  try {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const name = err && err.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    console.error(JSON.stringify({
      message: "deepseek request failed",
      error: timedOut ? "timeout" : (err instanceof Error ? err.message : String(err))
    }));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      content: "",
      reasoning: "",
      usage: null,
      error: timedOut ? "请求超时" : "连不上 DeepSeek，检查网络"
    };
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    if (res.body && typeof res.body.cancel === "function") {
      try { await res.body.cancel(); } catch (cancelErr) { /* already consumed */ }
    }
    return { ok: false, status: 502, content: "", reasoning: "", usage: null, error: "上游返回解析失败" };
  }

  if (!res.ok) {
    console.error(JSON.stringify({ message: "deepseek upstream error", status: res.status }));
    const msg = (data && data.error && data.error.message) || ("上游错误 " + res.status);
    return { ok: false, status: res.status || 500, content: "", reasoning: "", usage: null, error: msg };
  }

  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  return {
    ok: true,
    status: 200,
    content: String(msg.content || ""),
    reasoning: String(msg.reasoning_content || ""),
    usage: data.usage || null,
    error: ""
  };
}

module.exports = { complete };
