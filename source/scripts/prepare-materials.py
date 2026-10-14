"""Extract original Stroop PNGs and verify fixed offline speech assets.

This script does not alter DOCX files, speech content, colour values, or card pixels.
Only generated PCM WAV silence and loudness are processed before the material lock.
Run via prepare-materials.ps1 so every audio uses the same installed voice.
"""
from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
import struct
import sys
import wave
import zipfile
from datetime import datetime, timezone
from pathlib import Path

VERSION = "materials-1"
CARDS = {
    "W": ("word/media/image1.png", "W.png"),
    "C": ("word/media/image2.png", "C.png"),
    "CW-practice": ("word/media/image3.png", "CW-practice.png"),
    "CW": ("word/media/image4.png", "CW.png"),
}
WORDS = [
    ("lamei", "腊梅"), ("haitang", "海棠"), ("yulan", "玉兰"), ("baihe", "百合"),
    ("lvshi", "律师"), ("siji", "司机"), ("shibing", "士兵"), ("mugong", "木工"),
    ("changku", "长裤"), ("shoutao", "手套"), ("toujin", "头巾"), ("dayi", "大衣"),
]
CUES = [("delay-cue", "请告诉我您刚才记住的三个词。"), ("stop", "停。"), ("start", "开始")]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def png_dimensions(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("Expected unmodified PNG image")
    return struct.unpack(">II", data[16:24])


def extract_cards(root: Path, source: Path) -> dict:
    original = source.read_bytes()
    cards = []
    with zipfile.ZipFile(source) as document:
        for card_id, (member, filename) in CARDS.items():
            image = document.read(member)
            width, height = png_dimensions(image)
            destination = root / "public" / "cards" / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(image)
            if destination.read_bytes() != image:
                raise IOError(f"Card byte verification failed: {filename}")
            cards.append({
                "id": card_id, "url": f"cards/{filename}",
                "sourceMember": member, "sha256": sha256(image),
                "width": width, "height": height,
                "items": 4 if card_id == "CW-practice" else 50,
                "rows": 1 if card_id == "CW-practice" else 5,
                "columns": 4 if card_id == "CW-practice" else 10,
                "byteIdenticalToSource": True,
            })
    return {
        "version": VERSION,
        "sourceDocument": {"fileName": source.name, "sha256": sha256(original)},
        "cards": cards,
    }


def pcm16(path: Path) -> tuple[array.array, int]:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getcomptype() != "NONE":
            raise ValueError(f"Expected mono 16-bit PCM: {path.name}")
        sample_rate = audio.getframerate()
        samples = array.array("h", audio.readframes(audio.getnframes()))
        if sys.byteorder != "little":
            samples.byteswap()
    if not samples:
        raise ValueError(f"Empty audio: {path.name}")
    return samples, sample_rate


def metrics(samples: array.array, sample_rate: int) -> dict:
    peak = max(abs(value) for value in samples)
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    return {
        "durationMs": round(1000 * len(samples) / sample_rate, 3),
        "sampleRateHz": sample_rate,
        "channels": 1, "sampleBits": 16,
        "peakDbfs": round(20 * math.log10(max(peak, 1) / 32768), 3),
        "rmsDbfs": round(20 * math.log10(max(rms, 1) / 32768), 3),
        "clippedSamples": sum(abs(value) >= 32767 for value in samples),
    }


def prepare_audio(raw: Path, destination: Path) -> dict:
    """Trim only inaudible margins; preserve 120 ms on both sides of speech.

    Activity threshold is eight PCM units (-72.25 dBFS). It is far below speech.
    Fixed target full-file RMS is -23 dBFS, with peak limited to -1 dBFS.
    Both silence/gain parameters are recorded so raw-to-final processing is traceable.
    """
    samples, sample_rate = pcm16(raw)
    active = [index for index, value in enumerate(samples) if abs(value) > 8]
    if not active:
        raise ValueError(f"No speech detected: {raw.name}")
    margin = round(0.120 * sample_rate)
    start = max(0, active[0] - margin)
    end = min(len(samples), active[-1] + margin + 1)
    trimmed = samples[start:end]
    rms = math.sqrt(sum(value * value for value in trimmed) / len(trimmed))
    peak = max(abs(value) for value in trimmed)
    gain = min((32768 * 10 ** (-23 / 20)) / rms, (32768 * 10 ** (-1 / 20)) / peak)
    final = array.array("h", [round(value * gain) for value in trimmed])
    final_metrics = metrics(final, sample_rate)
    if final_metrics["clippedSamples"] != 0:
        raise ValueError(f"Clipping detected: {raw.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = array.array("h", final)
    if sys.byteorder != "little":
        encoded.byteswap()
    with wave.open(str(destination), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(encoded.tobytes())
    reread, rate = pcm16(destination)
    if rate != sample_rate or reread != final:
        raise IOError(f"Final WAV readback failed: {destination.name}")
    return {
        **final_metrics, "sha256": sha256(destination.read_bytes()),
        "rawSha256": sha256(raw.read_bytes()),
        "rawDurationMs": round(1000 * len(samples) / sample_rate, 3),
        "trimmedLeadingMs": round(1000 * start / sample_rate, 3),
        "trimmedTrailingMs": round(1000 * (len(samples) - end) / sample_rate, 3),
        "gainDb": round(20 * math.log10(gain), 3),
    }


def finalize(root: Path, source: Path, raw_dir: Path, speech_rate: int) -> dict:
    manifest = extract_cards(root, source)
    audio_entries = []
    for audio_id, content in WORDS + CUES:
        result = prepare_audio(raw_dir / f"{audio_id}.wav", root / "public" / "audio" / f"{audio_id}.wav")
        audio_entries.append({
            "id": audio_id, "text": content, "url": f"audio/{audio_id}.wav",
            "kind": "word" if (audio_id, content) in WORDS else "cue",
            **result,
        })
    manifest.update({
        "preparedAt": datetime.now(timezone.utc).isoformat(),
        "audio": audio_entries,
        "speech": {
            "engine": "System.Speech.Synthesis.SpeechSynthesizer",
            "voice": "Microsoft Huihui Desktop", "locale": "zh-CN", "gender": "Female",
            "rate": speech_rate, "volume": 100,
            "sampleRateHz": 22050, "channels": 1, "sampleBits": 16,
            "activityThresholdPcm": 8, "speechMarginMs": 120,
            "targetRmsDbfs": -23, "peakLimitDbfs": -1,
            "licenceStatement": "Installed Microsoft Windows voice; not represented as open-source audio or voice software.",
        },
        "review": {
            "technicalVerification": "passed",
            "researcherListening": "pending",
            "tabletListening": "pending",
            "formalCollectionLock": False,
        },
    })
    manifest_path = root / "public" / "material-manifest.json"
    write_json(manifest_path, manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["extract", "finalize", "verify"])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--raw-dir", type=Path)
    parser.add_argument("--speech-rate", type=int, default=0)
    args = parser.parse_args()
    if args.action == "extract":
        result = extract_cards(args.root, args.source)
        print(json.dumps(result, ensure_ascii=False))
    elif args.action == "finalize":
        if args.raw_dir is None:
            parser.error("--raw-dir is required for finalize")
        manifest = finalize(args.root, args.source, args.raw_dir, args.speech_rate)
        print(json.dumps({
            "manifest": str(args.root / "public" / "material-manifest.json"),
            "cards": len(manifest["cards"]), "audioFiles": len(manifest["audio"]),
            "wordDurationsMs": {entry["id"]: entry["durationMs"] for entry in manifest["audio"] if entry["kind"] == "word"},
            "researcherListening": "pending",
        }, ensure_ascii=False))
    else:
        manifest = read_json(args.root / "public" / "material-manifest.json")
        failures = []
        if sha256(args.source.read_bytes()) != manifest["sourceDocument"]["sha256"]:
            failures.append("Source DOCX hash changed")
        with zipfile.ZipFile(args.source) as document:
            for entry in manifest["cards"]:
                data = (args.root / "public" / entry["url"]).read_bytes()
                if sha256(data) != entry["sha256"] or data != document.read(entry["sourceMember"]):
                    failures.append(f"Card changed: {entry['id']}")
        for entry in manifest["audio"]:
            path = args.root / "public" / entry["url"]
            samples, rate = pcm16(path)
            if sha256(path.read_bytes()) != entry["sha256"]:
                failures.append(f"Audio changed: {entry['id']}")
            if metrics(samples, rate)["clippedSamples"] or rate != 22050:
                failures.append(f"Audio format or clipping invalid: {entry['id']}")
        if failures:
            raise ValueError("; ".join(failures))
        print(json.dumps({"verified": True, "cards": len(manifest["cards"]), "audio": len(manifest["audio"]), "version": manifest["version"]}))


if __name__ == "__main__":
    main()
