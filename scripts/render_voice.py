"""Render Drive coach lines with Kokoro to small mono MP3 clips.

af_river is the long-term coach. It writes public/voice/<hash>.mp3 and
public/voice/voice.json. Any other voice, including the temporary practice
voice af_bella, writes public/voice/<voice>/<hash>.mp3 and a voice.json in
that folder. It does not replace the river clips.

Usage: node scripts/voice-lines.mjs > /tmp/lines.json
       VOICE=af_river SPEED=0.95 python scripts/render_voice.py /tmp/lines.json /path/to/kokoro-v1.0.onnx /path/to/voices-v1.0.bin
       VOICE=af_bella SPEED=0.95 python scripts/render_voice.py /tmp/lines.json /path/to/kokoro-v1.0.onnx /path/to/voices-v1.0.bin
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
root = "public/voice" if voice == "af_river" else os.path.join("public/voice", voice)
os.makedirs(root, exist_ok=True)
with open(os.path.join(root, "voice.json"), "w") as meta:
    json.dump({"voice": voice, "speed": speed, "rate": 24000, "channels": 1, "bitrate": "48k"}, meta)
    meta.write("\n")
for line in json.load(open(lines_path)):
    out = os.path.join(root, os.path.basename(line["file"]))
    if os.path.exists(out) and not os.environ.get("FORCE"):
        continue
    samples, rate = kokoro.create(line["text"], voice=voice, speed=speed, lang="en-us")
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        sf.write(wav.name, samples, rate)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav.name, "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,apad=pad_dur=0.08",
                        "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "48k", out], check=True)
    print(out, line["text"])
