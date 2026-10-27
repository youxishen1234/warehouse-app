#!/usr/bin/env python3
"""Rebuild the small label font assets used by remote printing.

The updater has a 20-second native HTTP timeout on existing iOS builds. The
full Source Han Sans SC fonts make a hot update about 25 MB, so keep the web
bundle on the common GB2312 Level 1 character set and let the operating system
render uncommon glyphs via the CSS fallback stack.
"""

from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "src" / "assets" / "label-fonts"
COMMON_PUNCTUATION = "，。！？；：“”‘’（）【】《》、·—…￥×÷±%‰℃㎡²³①②③④⑤⑥⑦⑧⑨⑩"
FONT_FILES = {
    "SourceHanSansSC-Heavy.woff2": "SourceHanSansSC-Heavy.gb2312-l1.woff2",
    "SourceHanSansSC-Medium.woff2": "SourceHanSansSC-Medium.gb2312-l1.woff2",
}


def common_characters() -> str:
    chars = [chr(codepoint) for codepoint in range(0x20, 0x7F)]
    chars.extend(COMMON_PUNCTUATION)

    # GB2312 Level 1 contains the 3,755 most common simplified Chinese
    # characters. Keep the common-latin/punctuation prefix as well.
    for high in range(0xB0, 0xD8):
        for low in range(0xA1, 0xFF):
            try:
                chars.append(bytes((high, low)).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return "".join(dict.fromkeys(chars))


def main() -> int:
    try:
        import fontTools  # noqa: F401
    except ImportError:
        print("fontTools is required: python -m pip install fonttools[woff]", file=sys.stderr)
        return 1

    characters = common_characters()
    with tempfile.TemporaryDirectory(prefix="warehouse-label-fonts-") as temporary:
        text_file = Path(temporary) / "characters.txt"
        text_file.write_text(characters, encoding="utf-8")
        for source_name, output_name in FONT_FILES.items():
            source = FONT_DIR / source_name
            if not source.is_file():
                print(f"missing source font: {source}", file=sys.stderr)
                return 1
            output = FONT_DIR / output_name
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "fontTools.subset",
                    str(source),
                    f"--text-file={text_file}",
                    "--flavor=woff2",
                    f"--output-file={output}",
                    "--layout-features=*",
                    "--name-IDs=*",
                    "--name-languages=*",
                ],
                check=True,
            )
            print(f"{output.relative_to(ROOT)}: {output.stat().st_size} bytes")
    print(f"subset contains {len(characters)} characters")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
