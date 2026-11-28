#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""不下载模型，检查语言锁定、只转写、以及分块接口的文本原样返回。"""

import io
import math
import struct
import sys
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient

from server import (
    DEFAULT_MODEL_ID,
    FasterWhisperTranscriber,
    create_app,
    decode_wav,
    transcribe_pcm,
)


def make_wav(seconds=0.4, rate=16000, freq=440.0):
    frames = max(1, int(seconds * rate))
    pcm = bytearray()
    for index in range(frames):
        sample = int(8000 * math.sin(2 * math.pi * freq * index / rate))
        pcm += struct.pack("<h", sample)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(pcm))
    return buf.getvalue()


class Segment:
    def __init__(self, text):
        self.text = text


class FakeModel:
    def __init__(self, text):
        self.text = text
        self.calls = []

    def transcribe(self, samples, **kwargs):
        self.calls.append({"samples": samples, "kwargs": dict(kwargs)})
        return [Segment(self.text)], None


class ProtocolTests(unittest.TestCase):
    def test_transcribe_pcm_locks_language_and_never_translates(self):
        english = FakeModel("I like apples")
        text = transcribe_pcm(english, [0.0, 0.1, -0.1], "en", True)
        self.assertEqual(text, "I like apples")
        kwargs = english.calls[0]["kwargs"]
        self.assertEqual(kwargs["language"], "en")
        self.assertEqual(kwargs["task"], "transcribe")
        self.assertNotIn("translate", kwargs.values())
        self.assertNotIn("initial_prompt", kwargs)
        self.assertEqual(kwargs["beam_size"], 5)

        chinese = FakeModel("我喜欢苹果")
        partial = transcribe_pcm(chinese, [0.0, 0.2], "zh", False)
        self.assertEqual(partial, "我喜欢苹果")
        self.assertEqual(chinese.calls[0]["kwargs"]["language"], "zh")
        self.assertEqual(chinese.calls[0]["kwargs"]["task"], "transcribe")
        self.assertEqual(chinese.calls[0]["kwargs"]["beam_size"], 1)

        with self.assertRaises(ValueError):
            transcribe_pcm(english, [0.0], None, True)

    def test_http_returns_verbatim_text_for_the_selected_language(self):
        model = FakeModel("I like apples")

        def transcriber(samples, sample_rate, language, final):
            if language == "zh":
                model.text = "我喜欢苹果"
            else:
                model.text = "I like apples"
            return FasterWhisperTranscriber(model)(samples, sample_rate, language, final)

        client = TestClient(create_app(transcriber, DEFAULT_MODEL_ID))
        wav = make_wav()
        english = client.post(
            "/v1/transcribe",
            content=wav,
            headers={"x-speech-lang": "en", "x-speech-final": "0", "x-speech-task": "translate"},
        )
        self.assertEqual(english.status_code, 200)
        self.assertEqual(english.json(), {"text": "I like apples"})
        self.assertEqual(model.calls[-1]["kwargs"]["task"], "transcribe")
        self.assertEqual(model.calls[-1]["kwargs"]["language"], "en")

        chinese = client.post(
            "/v1/transcribe",
            content=wav,
            headers={"x-speech-lang": "zh", "x-speech-final": "1"},
        )
        self.assertEqual(chinese.status_code, 200)
        self.assertEqual(chinese.json(), {"text": "我喜欢苹果"})
        self.assertEqual(model.calls[-1]["kwargs"]["language"], "zh")
        self.assertEqual(model.calls[-1]["kwargs"]["task"], "transcribe")
        self.assertEqual(model.calls[-1]["kwargs"]["beam_size"], 5)

    def test_missing_or_auto_language_does_not_transcribe(self):
        called = {"n": 0}

        def transcriber(samples, sample_rate, language, final):
            called["n"] += 1
            return "nope"

        client = TestClient(create_app(transcriber, DEFAULT_MODEL_ID))
        wav = make_wav(0.2)
        missing = client.post("/v1/transcribe", content=wav)
        auto = client.post("/v1/transcribe", content=wav, headers={"x-speech-lang": "auto"})
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(auto.status_code, 400)
        self.assertEqual(called["n"], 0)

    def test_token_and_wav_and_health(self):
        def transcriber(samples, sample_rate, language, final):
            return "hello"

        client = TestClient(create_app(transcriber, DEFAULT_MODEL_ID, token="family-token"))
        health = client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["model"], DEFAULT_MODEL_ID)
        self.assertNotIn("family-token", health.text)

        wav = make_wav(0.2)
        denied = client.post("/v1/transcribe", content=wav, headers={"x-speech-lang": "en"})
        self.assertEqual(denied.status_code, 401)
        allowed = client.post(
            "/v1/transcribe",
            content=wav,
            headers={"x-speech-lang": "en", "authorization": "Bearer family-token"},
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.json()["text"], "hello")

        bad = client.post(
            "/v1/transcribe",
            content=b"not-wav",
            headers={"x-speech-lang": "en", "authorization": "Bearer family-token"},
        )
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.json()["error"], "音频格式不对")

    def test_decode_wav_resamples_to_16k(self):
        samples, rate = decode_wav(make_wav(seconds=0.5, rate=8000))
        self.assertEqual(rate, 16000)
        self.assertGreater(len(samples), 7000)
        self.assertLess(len(samples), 9000)


if __name__ == "__main__":
    unittest.main()
