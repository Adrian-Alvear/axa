"""AXA's resident Kokoro speaker: loads the Kokoro model once (sherpa-onnx), then turns JSON lines into wav files.

Run with the venv's python:  python -I voice-kokoro.py --model DIR [--threads 4]
stdin  (one JSON object per line):  {"id": 1, "text": "...", "sid": 3, "speed": 1.0, "out": "/tmp/x.wav"}
                                    {"cancel": 1}   drops request 1 (its reply says "cancelled")
stdout (one JSON object per line):  {"ready": true, "load": 1.9}   once the model is loaded
                                    {"id": 1, "ok": true, "out": "...", "secs": 0.9, "audio": 2.4}
                                    {"id": 1, "ok": false, "error": "..."}
It exits when stdin closes (the daemon went away).
"""
import argparse
import json
import os
import queue
import sys
import threading
import time


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()

    import sherpa_onnx

    t0 = time.time()
    m = a.model
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=os.path.join(m, "model.onnx"), voices=os.path.join(m, "voices.bin"),
            tokens=os.path.join(m, "tokens.txt"), lexicon=os.path.join(m, "lexicon-us-en.txt")),
        num_threads=a.threads)))
    say({"ready": True, "load": round(time.time() - t0, 2)})

    jobs = queue.Queue()
    cancelled = set()

    def reader():
        for line in sys.stdin:
            try:
                req = json.loads(line)
            except ValueError:
                continue
            if "cancel" in req:
                cancelled.add(req["cancel"])
            else:
                jobs.put(req)
        jobs.put(None)

    threading.Thread(target=reader, daemon=True).start()

    while True:
        req = jobs.get()
        if req is None:
            return
        rid = req.get("id")
        if rid in cancelled:
            cancelled.discard(rid)
            say({"id": rid, "ok": False, "error": "cancelled"})
            continue
        try:
            t = time.time()
            # (no progress callback: it needs numpy, which sherpa-onnx doesn't install; a cancel lands after)
            audio = tts.generate(str(req["text"]), sid=int(req.get("sid", 3)), speed=float(req.get("speed", 1.0)))
            if rid in cancelled:
                cancelled.discard(rid)
                say({"id": rid, "ok": False, "error": "cancelled"})
                continue
            if len(audio.samples) == 0:
                raise RuntimeError("no audio (nothing speakable?)")
            sherpa_onnx.write_wave(req["out"], audio.samples, audio.sample_rate)
            say({"id": rid, "ok": True, "out": req["out"], "secs": round(time.time() - t, 3),
                 "audio": round(len(audio.samples) / audio.sample_rate, 2)})
        except Exception as e:  # one bad request mustn't take the speaker down
            say({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
