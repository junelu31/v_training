"""Download a small LibriSpeech speaker sample for the profile eval.

Audio is written under /tmp/lilt-profile and is not part of the repo.
Source: OpenSLR LibriSpeech (CC BY 4.0), streamed from the Hugging Face
mirror openslr/librispeech_asr. Speaker gender comes from SPEAKERS.TXT,
which this script downloads from the train-clean-100 archive.
"""
import io
import json
import os
import sys
import tarfile
import urllib.request

import numpy as np
import soundfile as sf
from datasets import Audio, load_dataset

OUT = '/tmp/lilt-profile'
SPEAKERS = '/tmp/SPEAKERS.TXT'
TARGET = 100


def ensure_speakers():
    if os.path.exists(SPEAKERS) and os.path.getsize(SPEAKERS) > 1000:
        return
    url = 'https://www.openslr.org/resources/12/train-clean-100.tar.gz'
    response = urllib.request.urlopen(url, timeout=60)
    archive = tarfile.open(fileobj=response, mode='r|gz')
    for member in archive:
        if member.name.endswith('SPEAKERS.TXT'):
            with open(SPEAKERS, 'wb') as handle:
                handle.write(archive.extractfile(member).read())
            break
    response.close()


def speaker_genders():
    genders = {}
    for line in open(SPEAKERS, encoding='utf-8'):
        if not line.strip() or line.startswith(';'):
            continue
        parts = [part.strip() for part in line.split('|')]
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        if parts[2] == 'train-clean-100' and parts[1] in {'F', 'M'}:
            genders[int(parts[0])] = 'feminine' if parts[1] == 'F' else 'masculine'
    return genders


def to_16k(audio, rate):
    if rate == 16000:
        return audio.astype(np.float32)
    length = max(1, int(round(len(audio) * 16000 / rate)))
    positions = np.linspace(0, len(audio) - 1, length)
    left = np.floor(positions).astype(int)
    right = np.minimum(left + 1, len(audio) - 1)
    frac = (positions - left).astype(np.float32)
    return (audio[left] * (1 - frac) + audio[right] * frac).astype(np.float32)


def main():
    os.makedirs(OUT, exist_ok=True)
    ensure_speakers()
    genders = speaker_genders()
    counts = {'feminine': 0, 'masculine': 0}
    seen = set()
    manifest = []
    manifest_path = os.path.join(OUT, 'manifest.json')
    if os.path.exists(manifest_path):
        previous = json.load(open(manifest_path, encoding='utf-8'))
        for speaker in previous.get('speakers', []):
            if not os.path.exists(os.path.join(OUT, speaker['file'])):
                continue
            if speaker['label'] not in counts or counts[speaker['label']] >= TARGET:
                continue
            seen.add(int(speaker['id']))
            counts[speaker['label']] += 1
            manifest.append(speaker)
        print('resumed', counts, flush=True)
    dataset = load_dataset('openslr/librispeech_asr', 'clean', split='train.100', streaming=True)
    dataset = dataset.cast_column('audio', Audio(decode=False))
    for row in dataset:
        speaker = int(row['speaker_id'])
        label = genders.get(speaker)
        if not label or speaker in seen or counts[label] >= TARGET:
            if counts['feminine'] >= TARGET and counts['masculine'] >= TARGET:
                break
            continue
        payload = row['audio'].get('bytes')
        if not payload:
            continue
        audio, rate = sf.read(io.BytesIO(payload), dtype='float32', always_2d=False)
        if getattr(audio, 'ndim', 1) > 1:
            audio = audio.mean(axis=1)
        audio = to_16k(np.asarray(audio, dtype=np.float32), rate)
        if len(audio) < 16000:
            continue
        audio = audio[: 16000 * 4]
        seen.add(speaker)
        counts[label] += 1
        name = f'{label}-{speaker}.f32'
        audio.tofile(os.path.join(OUT, name))
        manifest.append({'id': str(speaker), 'label': label, 'file': name, 'text': row['text'][:180]})
        print(label, speaker, counts, flush=True)
        if counts['feminine'] >= TARGET and counts['masculine'] >= TARGET:
            break
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as handle:
        json.dump({'license': 'CC BY 4.0', 'source': 'OpenSLR LibriSpeech train-clean-100 via Hugging Face openslr/librispeech_asr', 'speakers': manifest}, handle, indent=2)
    print('wrote', len(manifest), file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    finally:
        os._exit(0)
