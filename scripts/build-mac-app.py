"""Package "Stremio Neo.app" into build/StremioNeo-mac.zip.

The Mac app is a plain bundle around a shell script (mac/StremioNeo), so it
can be assembled on any OS. The zip is written by hand so the launcher keeps
its executable bit and LF line endings even when built on Windows.

Run with:  python scripts/build-mac-app.py
Needs Pillow for the .icns icon; without it the app ships with no icon.
"""
import io
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = "Stremio Neo.app"
OUT = os.path.join(ROOT, "build", "StremioNeo-mac.zip")


def read_lf(path):
    with open(path, "rb") as f:
        return f.read().replace(b"\r\n", b"\n")


def icns_bytes():
    try:
        from PIL import Image
    except ImportError:
        print("WARN: Pillow not installed, building without an icon")
        return None
    src = Image.open(os.path.join(ROOT, "assets", "images", "icon_512x512.png")).convert("RGBA")
    buf = io.BytesIO()
    src.save(buf, format="ICNS", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512)])
    return buf.getvalue()


def add(zf, name, data, mode):
    info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.create_system = 3  # Unix, so the mode bits below are honoured
    info.external_attr = (0o100000 | mode) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    zf.writestr(info, data)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, "w") as zf:
        add(zf, APP + "/Contents/Info.plist", read_lf(os.path.join(ROOT, "mac", "Info.plist")), 0o644)
        add(zf, APP + "/Contents/MacOS/StremioNeo", read_lf(os.path.join(ROOT, "mac", "StremioNeo")), 0o755)
        icon = icns_bytes()
        if icon:
            add(zf, APP + "/Contents/Resources/StremioNeo.icns", icon, 0o644)
    print("OK:", OUT, os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    main()
