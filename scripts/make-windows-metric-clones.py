#!/usr/bin/env python3
"""
Emit Windows-named font files whose glyphs come from open metric clones.

Why this exists, and why the obvious approach does not work.

The container claims Windows in its UA. A real Windows Chrome exposes the Windows
core fonts, and a page can test for them from JavaScript by measuring text width
with the font requested and comparing against a generic fallback. Ours exposed
almost none, which is the "Linux under a Windows UA" tell — CloakBrowser prints a
warning about it at every launch.

The tempting fix is fontconfig aliases (Segoe UI -> Open Sans). It does not work.
`fc-match "Segoe UI"` happily reports Open Sans, but Chromium's canvas still
falls through to the next family in the list and the font measures as ABSENT.
Verified on Ubuntu 24.04 with the same Chromium the bot runs, in both
/etc/fonts/local.conf and /etc/fonts/conf.d/, with one-way and bidirectional
aliases. The five that already pass (Arial, Times New Roman, Courier New,
Calibri, Cambria) pass because Liberation/Carlito/Caladea are installed as real
files, not because of the aliases in 30-metric-aliases.conf.

So the family has to genuinely exist. This rewrites the name table of an open
substitute and installs it under the Windows family name. Glyphs, hinting and
licence stay those of the source font; only the name changes.

NOTE ON METRICS: only some of these are true metric clones (Liberation for
Arial/Times/Courier, Carlito for Calibri, Caladea for Cambria). The rest are
visual stand-ins. That closes "is the family present", which is what the common
enumeration probes test. It does NOT survive a detector that compares glyph
advance widths against real Windows metrics.
"""

import os
import subprocess
import sys

from fontTools.ttLib import TTFont

OUT_DIR = "/usr/share/fonts/truetype/win-metric-clones"

# (Windows family, source family). Source must already be installed as its own
# family — a style within another family (e.g. "DejaVu Sans Condensed") does not
# qualify, because fc-match resolves it to the parent and the guard rejects it.
CLONES = [
    # --- CloakBrowser's own gate --------------------------------------------
    # cloakbrowser/dist/fonts.js WINDOWS_FONT_TELLS. It shells out to `fc-list`
    # and substring-matches the RAW listing, then warns unless ALL eight are
    # found. Two consequences worth spelling out:
    #
    #  1. Fontconfig aliases are invisible to it. Carlito satisfies "Calibri"
    #     for a canvas measurement but the string "calibri" never appears in
    #     fc-list, so the gate counted it missing. Same for Courier New via
    #     Liberation Mono. Both must be cloned as real files.
    #  2. It is a substring match, so "Franklin Gothic Medium" already satisfies
    #     the "Franklin Gothic" tell.
    ("Segoe UI", "Open Sans"),
    ("Segoe UI Light", "Cantarell"),
    ("Calibri", "Carlito"),
    ("Marlett", "FreeSerif"),
    ("MS UI Gothic", "IPAPGothic"),
    ("Franklin Gothic Medium", "Lato"),
    ("Consolas", "Cascadia Mono"),
    ("Courier New", "Liberation Mono"),
    # --- the rest of the Windows core set ------------------------------------
    # Not gated by CloakBrowser, but enumerated by the common JS font probes
    # (and by our own fingerprint-probe.ts WINDOWS_FONTS list).
    ("Arial", "Liberation Sans"),
    ("Times New Roman", "Liberation Serif"),
    ("Cambria", "Caladea"),
    ("Tahoma", "DejaVu Sans"),
    ("Verdana", "Noto Sans"),
    ("Georgia", "DejaVu Serif"),
    ("Trebuchet MS", "FreeSans"),
    ("Lucida Console", "DejaVu Sans Mono"),
    ("Comic Sans MS", "Comic Neue"),
    ("Impact", "Liberation Sans Narrow"),
    ("Bahnschrift", "Open Sans Condensed"),
    ("Candara", "Cantarell"),
    ("Corbel", "Carlito"),
    ("Segoe UI Emoji", "Noto Color Emoji"),
    ("MS Gothic", "IPAGothic"),
]


def source_file(family: str) -> str | None:
    """Resolve an installed source font to a file, refusing a fallback match."""
    got = subprocess.run(
        ["fc-match", "-f", "%{family[0]}\t%{file}", family],
        capture_output=True, text=True, check=False
    ).stdout.strip()
    if "\t" not in got:
        return None
    matched_family, path = got.split("\t", 1)
    # fc-match ALWAYS returns something. If it fell back to a different family the
    # source is not installed, and silently cloning the fallback would produce a
    # "Windows" font that is really DejaVu — the exact failure this script exists
    # to avoid. Refuse it.
    if matched_family.strip().lower() != family.strip().lower():
        print(f"  ✗ {family:<24} not installed (fc-match fell back to {matched_family})")
        return None
    # urw-base35 and friends ship Type1 (.pfb), which fontTools cannot open as an
    # sfnt. Reject by extension rather than letting the exception kill the build.
    if not path.lower().endswith((".ttf", ".otf", ".ttc")):
        print(f"  ✗ {family:<24} source is not sfnt ({os.path.basename(path)})")
        return None
    return path


def clone(win_family: str, src_path: str) -> None:
    font = TTFont(src_path)
    postscript = win_family.replace(" ", "")
    for rec in font["name"].names:
        # 1 = family, 4 = full name, 16 = typographic family, 6 = PostScript name.
        if rec.nameID in (1, 4, 16):
            rec.string = win_family
        elif rec.nameID == 6:
            rec.string = postscript
    font.save(os.path.join(OUT_DIR, f"{postscript}.ttf"))


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    made, missing = 0, []
    for win_family, src_family in CLONES:
        path = source_file(src_family)
        if path is None:
            missing.append(win_family)
            continue
        try:
            clone(win_family, path)
        except Exception as exc:  # noqa: BLE001 — never fail an image build over a font
            print(f"  ✗ {win_family:<24} clone failed: {exc}")
            missing.append(win_family)
            continue
        print(f"  ✓ {win_family:<24} <- {src_family} ({os.path.basename(path)})")
        made += 1
    subprocess.run(["fc-cache", "-f"], check=False, capture_output=True)
    print(f"[win-fonts] {made}/{len(CLONES)} generated into {OUT_DIR}")
    if missing:
        # Loud, but not fatal: a partial set is still better than none, and a
        # failed image build over a font is worse than a slightly weaker spoof.
        print(f"[win-fonts] WARNING missing sources for: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
