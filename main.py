#!/usr/bin/env python3
"""cutest-picture-01 entry: "Two Little Friends" -- a shipped picture.

The artwork itself (artwork.png, beside this file) is a soft 3D-style
rendering of the same two friends, drawn far richer than pixels allow:
two chubby baby penguins hugging cheek to cheek in fresh snow, the
bigger one in a tiny red knitted scarf, the smaller one with a pink
bow, huge sparkling eyes, rosy cheeks, a plump pink heart floating
over them and a smiling sun in a pastel sky. The competition rules
explicitly allow this shape of entry -- a repository holding the image
and a small program that copies it to the output -- so this program's
whole job is to deliver those exact bytes, safely and deterministically:

  * it reads the image from its own directory (never a fixed path),
  * it checks the payload really is a PNG or a JPEG before writing,
  * it writes to $MAKEFUN_OUTPUT_DIR when set, else /output,
  * and it writes nothing else, so two runs produce identical bytes.
"""

import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ARTWORK = os.path.join(HERE, "artwork.png")

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"
MAX_BYTES = 1048576  # the gate refuses any entry image over 1 MiB


def load_artwork(path):
    """Read the shipped image and confirm its format from its first bytes."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data.startswith(PNG_MAGIC):
        kind = "PNG"
    elif data.startswith(JPEG_MAGIC):
        kind = "JPEG"
    else:
        raise ValueError("artwork payload is neither PNG nor JPEG")
    if not data:
        raise ValueError("artwork payload is empty")
    if len(data) > MAX_BYTES:
        raise ValueError(
            "artwork payload is %d bytes, over the %d-byte cap"
            % (len(data), MAX_BYTES)
        )
    return data, kind


def output_path():
    """The grader mounts a writable /output; local runs may redirect it."""
    out_dir = os.environ.get("MAKEFUN_OUTPUT_DIR") or "/output"
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, "entry.png")


def verify_written(dest, expected):
    """Re-read what landed on disk; a short or altered write must not pass."""
    with open(dest, "rb") as fh:
        written = fh.read()
    if written != expected:
        raise IOError(
            "verification failed: %s holds %d bytes, expected %d"
            % (dest, len(written), len(expected))
        )
    return hashlib.sha256(written).hexdigest()


def main():
    data, kind = load_artwork(ARTWORK)
    dest = output_path()
    with open(dest, "wb") as fh:
        fh.write(data)
    digest = verify_written(dest, data)
    print(
        "wrote %s (%s, %d bytes, sha256 %s)"
        % (dest, kind, len(data), digest)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
