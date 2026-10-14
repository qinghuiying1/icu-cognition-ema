"""Create title-free Stroop display images without altering task pixels.

The source PNGs remain the scoring/material originals.  Only white margins and
the title above the 5 x 10 matrix are removed from the display derivatives.
"""
from pathlib import Path
import hashlib
import json

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[1]
CARDS = ROOT / "public" / "cards"
DISPLAY = CARDS / "display"
CROPS = {
    "W": (24, 98, 775, 342),
    "C": (23, 60, 774, 301),
    "CW": (21, 57, 859, 378),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    DISPLAY.mkdir(parents=True, exist_ok=True)
    entries = []
    for card, box in CROPS.items():
        source_path = CARDS / f"{card}.png"
        source = Image.open(source_path)
        # Region y >= 50 excludes each embedded title and includes all task items.
        rgb = source.convert("RGB")
        difference = ImageChops.difference(rgb, Image.new("RGB", rgb.size, "white"))
        task_bounds = difference.crop((0, 50, source.width, source.height)).getbbox()
        assert task_bounds is not None
        x0, y0, x1, y1 = task_bounds
        task_bounds = (x0, y0 + 50, x1, y1 + 50)
        assert box[0] <= task_bounds[0] and box[1] <= task_bounds[1]
        assert box[2] >= task_bounds[2] and box[3] >= task_bounds[3]
        cropped = source.crop(box)
        output = DISPLAY / f"{card}.png"
        cropped.save(output)
        reopened = Image.open(output)
        assert reopened.mode == cropped.mode
        assert reopened.size == cropped.size
        assert reopened.tobytes() == cropped.tobytes()
        entries.append({
            "card": card,
            "source": f"cards/{card}.png",
            "display": f"cards/display/{card}.png",
            "sourceSize": list(source.size),
            "cropBox": list(box),
            "taskBounds": list(task_bounds),
            "displaySize": list(cropped.size),
            "sourceSha256": digest(source_path),
            "displaySha256": digest(output),
            "taskPixelsUnchanged": True,
        })
    manifest = {
        "displayVersion": "title-free-1",
        "transformation": "Lossless pixel crop only; no resizing, recoloring, or item changes.",
        "coordinateConvention": "[left, top, right-exclusive, bottom-exclusive] in source pixels",
        "originalFilesPreserved": True,
        "cards": entries,
    }
    (DISPLAY / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
