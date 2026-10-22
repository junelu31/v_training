"""Render Drive coach lines with Kokoro (voice af_heart) to small mono MP3 clips.

Usage: node scripts/voice-lines.mjs > /tmp/lines.json
       python scripts/render_voice.py /tmp/lines.json /path/to/kokoro-v1.0.onnx /path/to/voices-v1.0.bin
       node scripts/voice-lines.mjs --manifest
Needs: pip install kokoro-onnx soundfile, and ffmpeg.
"""
import json, os, subprocess, sys, tempfile
import soundfile as sf
from kokoro_onnx import Kokoro

lines_path, model, voices = sys.argv[1:4]
voice = os.environ.get("VOICE", "af_heart")
speed = float(os.environ.get("SPEED", "0.95"))
kokoro = Kokoro(model, voices)
os.makedirs("public/voice", exist_ok=True)
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
