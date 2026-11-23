"""A stand-in for src/core/voice-kokoro.py (same protocol, no model): for the resident speaker tests.
text "crash" exits, "slow" takes 2 s, "bad" fails; anything else writes a tiny file at "out"."""
import json
import os
import sys
import time

print(json.dumps({"ready": True, "load": 0.01, "pid": os.getpid()}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if "cancel" in req:
        continue
    if "preload" in req:
        print(json.dumps({"id": req["id"], "ok": True, "preloaded": len(req["preload"]), "load": 0.01}), flush=True)
        continue
    text = req["text"]
    if text == "crash":
        sys.stderr.write("boom: the fake speaker crashed\n")
        sys.exit(3)
    if text == "slow":
        time.sleep(2)
    if text == "bad":
        print(json.dumps({"id": req["id"], "ok": False, "error": "no audio"}), flush=True)
        continue
    with open(req["out"], "w") as f:
        f.write(f"{text}|{req['sid']}|{req['speed']}|{os.getpid()}")
    print(json.dumps({"id": req["id"], "ok": True, "out": req["out"], "secs": 0.01, "audio": 1.0}), flush=True)
