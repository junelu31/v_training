"""Render Drive coach lines with one Kokoro voice to small mono MP3 clips.

The default voice is af_river, the long-term target. The practice voice is
af_bella, written under public/voice/af_bella/. Re-run with VOICE set to the
id and FORCE=1 to rebuild clips that already exist.

Usage: node scripts/voice-lines.mjs > /tmp/lines.json
       VOICE=af_river SPEED=0.95 FORCE=1 python scripts/render_voice.py /tmp/lines.json /path/to/kokoro-v1.0.onnx /path/to/voices-v1.0.bin
       node scripts/voice-lines.mjs --manifest
Needs: pip install kokoro-onnx soundfile, and ffmpeg.
"""
import json, os, subprocess, sys, tempfile
import soundfile as sf
from kokoro_onnx import Kokoro

lines_path, model, voices = sys.argv[1:4]
voice = os.environ.get("VOICE", "af_river")
speed = float(os.environ.get("SPEED", "0.95"))
kokoro = Kokoro(model, voices)
meta_dir = "public/voice" if voice == "af_river" else f"public/voice/{voice}"
os.makedirs(meta_dir, exist_ok=True)
with open(os.path.join(meta_dir, "voice.json"), "w") as meta:
    json.dump({"voice": voice, "speed": speed, "rate": 24000, "channels": 1, "bitrate": "48k"}, meta)
    meta.write("\n")
for line in json.load(open(lines_path)):
    out = os.path.join("public", line["file"])
    if os.path.exists(out) and not os.environ.get("FORCE"):
        continue
    samples, rate = kokoro.create(line["text"], voice=voice, speed=speed, lang="en-us")
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        sf.write(wav.name, samples, rate)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav.name, "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,apad=pad_dur=0.08",
                        "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "48k", out], check=True)
    print(out, line["text"])
