"""AXA's resident Kokoro speaker: loads the Kokoro model once (sherpa-onnx), then turns JSON lines into wav files.

Run with the venv's python:  python -I voice-kokoro.py --model DIR [--threads 4]
stdin  (one JSON object per line):  {"id": 1, "text": "...", "sid": 3, "speed": 1.0, "out": "/tmp/x.wav"}
                                    optional "extra": {"word": "phonemes"} for words the model's lexicon lacks, and
                                    "phonemes": ["ð i ...", ...] (the reply as Kokoro phoneme tokens, one per sentence)
                                    {"cancel": 1}   drops request 1 (its reply says "cancelled")
Out-of-lexicon words: sherpa-onnx skips any word its lexicon lacks. Words already in the speaker's extra lexicon
are read from the text as usual; a reply with new ones is said from its phonemes (nothing dropped) while a model
with the bigger extra lexicon (a file in the temp folder) loads in the background, then replaces the current one.
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
import tempfile
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

    def load(lexicon):
        return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(m, "model.onnx"), voices=os.path.join(m, "voices.bin"),
                tokens=os.path.join(m, "tokens.txt"), lexicon=lexicon),
            num_threads=a.threads)))

    base = os.path.join(m, "lexicon-us-en.txt")
    tts = load(base)
    say({"ready": True, "load": round(time.time() - t0, 2)})

    # the extra lexicon: words loaded in `tts`, and the next model loading in the background
    known = {}
    swap = {"tts": None, "known": None, "busy": False}
    lock = threading.Lock()
    extra_file = os.path.join(tempfile.gettempdir(), "axa-kokoro-extra-%d.txt" % os.getpid())

    def grow(words):
        def run():
            try:
                with open(extra_file, "w", encoding="utf8") as f:
                    for w, ph in words.items():
                        f.write(w + " " + " ".join(ph) + "\n")
                t = time.time()
                new = load(extra_file + "," + base)
                with lock:
                    swap["tts"], swap["known"] = new, words
                say({"lexicon": len(words), "load": round(time.time() - t, 2)})
            except Exception as e:
                say({"lexicon": 0, "error": str(e)})
            finally:
                with lock:
                    swap["busy"] = False
        with lock:
            if swap["busy"]:
                return
            swap["busy"] = True
        threading.Thread(target=run, daemon=True).start()

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
            try:
                os.unlink(extra_file)
            except OSError:
                pass
            return
        rid = req.get("id")
        if rid in cancelled:
            cancelled.discard(rid)
            say({"id": rid, "ok": False, "error": "cancelled"})
            continue
        with lock:
            if swap["tts"] is not None:
                tts, known = swap["tts"], swap["known"]
                swap["tts"] = swap["known"] = None
        try:
            t = time.time()
            # (no progress callback: it needs numpy, which sherpa-onnx doesn't install; a cancel lands after)
            extra = {str(w).lower(): str(p) for w, p in (req.get("extra") or {}).items() if str(w).strip() and str(p).strip() and " " not in str(w)}
            new = {w: p for w, p in extra.items() if known.get(w) != p}
            if new and len(known) < 20000:
                grow({**known, **new})
            ph = req.get("phonemes") if new else None
            if ph:
                g = sherpa_onnx.GenerationConfig()
                g.sid = int(req.get("sid", 3))
                g.speed = float(req.get("speed", 1.0))
                g.tokens = [list(str(c)) for c in ph if str(c).strip()]
                audio = tts.generate(str(req.get("text", "")), g)
            else:
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
