#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小树英语的语音服务。

faster-whisper 的 WhisperModel.transcribe 一次转写一整段音频，没有流式接口。
浏览器一边说，一边把「从这一句开头到现在」的 16-bit PCM WAV 反复交过来。
这是分块重转写：每一块都是当前这句话的前缀，返回的 text 是到目前为止的转写。

每次都锁定页面上选的语言（en 或 zh），task 固定为 transcribe。
不自动检测语言，也不做翻译。音频只在内存里用一下，不落盘。

默认模型是 mobiuslabsgmbh/faster-whisper-large-v3-turbo
（faster-whisper 里的名字是 large-v3-turbo，别名 turbo）。
它能听中文和英文。服务要跑在一台常开的电脑上，不能放进 Cloudflare Worker。

    pip install -r asr/requirements.txt
    python3 asr/server.py

默认只听 127.0.0.1:8788。本机的 node server.js 会把 /api/transcribe 转到这里。
线上的 Worker 够不到这台机器的本机端口，要把 WHISPER_URL 设成 Worker 能访问的地址。
如果设置了 WHISPER_TOKEN，请求必须带 Authorization: Bearer。不要把口令写进仓库。
"""

from __future__ import annotations

import hmac
import io
import os
import struct
import wave

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

DEFAULT_MODEL_ID = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
DEFAULT_MODEL_ALIAS = "large-v3-turbo"
SAMPLE_RATE = 16000
MAX_SECONDS = 120


def decode_wav(data: bytes):
    if not data:
        raise ValueError("没有收到音频")
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            rate = handle.getframerate()
            width = handle.getsampwidth()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as exc:
        raise ValueError("音频格式不对") from exc
    if width != 2 or channels not in (1, 2) or rate <= 0 or not frames:
        raise ValueError("音频格式不对")
    count = len(frames) // 2
    if count < 1:
        raise ValueError("没有收到音频")
    pcm = struct.unpack("<" + "h" * count, frames[: count * 2])
    if channels == 1:
        samples = [sample / 32768.0 for sample in pcm]
    else:
        samples = [pcm[index] / 32768.0 for index in range(0, count, 2)]
    duration = len(samples) / float(rate)
    if duration <= 0:
        raise ValueError("没有收到音频")
    if duration > MAX_SECONDS:
        raise ValueError("音频超过 120 秒")
    if rate != SAMPLE_RATE:
        samples = resample(samples, rate, SAMPLE_RATE)
    return samples, SAMPLE_RATE


def resample(samples, from_rate, to_rate):
    if from_rate == to_rate or not samples:
        return samples
    new_len = max(1, int(round(len(samples) * float(to_rate) / float(from_rate))))
    if new_len == 1:
        return [samples[0]]
    scale = float(from_rate) / float(to_rate)
    last = len(samples) - 1
    out = []
    for index in range(new_len):
        pos = index * scale
        left = int(pos)
        if left >= last:
            out.append(samples[last])
            continue
        frac = pos - left
        out.append(samples[left] * (1.0 - frac) + samples[left + 1] * frac)
    return out


def transcribe_pcm(model, samples, language, final):
    """只做转写。language 必须是调用方已经锁定的 en 或 zh。"""
    if language not in ("en", "zh"):
        raise ValueError("请先选择中文或英文")
    segments, _info = model.transcribe(
        samples,
        language=language,
        task="transcribe",
        vad_filter=True,
        beam_size=5 if final else 1,
        temperature=0.0,
        without_timestamps=True,
        condition_on_previous_text=False,
    )
    return "".join(segment.text for segment in segments).strip()


class FasterWhisperTranscriber:
    def __init__(self, model):
        self.model = model

    def __call__(self, samples, sample_rate, language, final):
        audio = samples
        if sample_rate != SAMPLE_RATE:
            audio = resample(samples, sample_rate, SAMPLE_RATE)
        try:
            import numpy as np
            audio = np.asarray(audio, dtype="float32")
        except Exception:
            pass
        return transcribe_pcm(self.model, audio, language, final)


def load_model(model_id, device, compute_type):
    from faster_whisper import WhisperModel

    kwargs = {"device": device, "compute_type": compute_type}
    if device == "cpu":
        threads = int(os.environ.get("WHISPER_CPU_THREADS", "4") or "4")
        kwargs["cpu_threads"] = max(1, threads)
    return WhisperModel(model_id, **kwargs)


def create_app(transcriber, model_id, token=""):
    app = FastAPI()
    expected = str(token or "")

    @app.get("/health")
    def health():
        return {"ok": True, "model": model_id}

    @app.post("/v1/transcribe")
    async def transcribe(request: Request):
        if expected:
            auth = request.headers.get("authorization", "")
            if not hmac.compare_digest(auth, "Bearer " + expected):
                return JSONResponse({"error": "识别服务拒绝了请求"}, status_code=401)
        language = (request.headers.get("x-speech-lang") or "").strip().lower()
        if language not in ("en", "zh"):
            return JSONResponse({"error": "请先选择中文或英文"}, status_code=400)
        final = (request.headers.get("x-speech-final") or "").strip() == "1"
        data = await request.body()
        try:
            samples, rate = decode_wav(data)
            text = transcriber(samples, rate, language, final)
        except ValueError as exc:
            message = str(exc) or "音频格式不对"
            status = 400 if "超过" not in message else 400
            if message not in ("没有收到音频", "音频格式不对", "音频超过 120 秒", "请先选择中文或英文"):
                message = "音频格式不对"
            return JSONResponse({"error": message}, status_code=status)
        except Exception:
            return JSONResponse({"error": "识别失败"}, status_code=502)
        if not isinstance(text, str):
            text = ""
        return {"text": text.strip()}

    return app


def main():
    model_id = (os.environ.get("WHISPER_MODEL") or DEFAULT_MODEL_ID).strip() or DEFAULT_MODEL_ID
    device = (os.environ.get("WHISPER_DEVICE") or "cpu").strip() or "cpu"
    compute_type = (os.environ.get("WHISPER_COMPUTE_TYPE") or "int8").strip() or "int8"
    token = (os.environ.get("WHISPER_TOKEN") or "").strip()
    host = (os.environ.get("WHISPER_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.environ.get("WHISPER_PORT") or "8788")
    model = load_model(model_id, device, compute_type)
    app = create_app(FasterWhisperTranscriber(model), model_id, token)
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
