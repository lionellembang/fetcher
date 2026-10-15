#!/usr/bin/env python3
"""Predict how much of a recording auto-editor will keep, without encoding.

Reproduces auto-editor's per-frame peak test (--edit audio:<dB>, --margin b,a).
Matched the real -19 dB / 0.2s,0.2s results to within ~1%.

usage: python3 predict_cuts.py FILE.mp4 [FILE.mp4 ...]
       python3 predict_cuts.py --th -30 --before 0.3 --after 0.5 FILE.mp4
requires: ffmpeg on PATH, numpy
"""
import argparse
import subprocess

import numpy as np

SR, FPS = 16000, 25


def frame_peaks(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1",
         "-ar", str(SR), "-f", "s16le", "-"],
        capture_output=True, check=True).stdout
    a = np.abs(np.frombuffer(raw, np.int16).astype(np.float32)) / 32768
    spf = SR // FPS
    n = len(a) // spf
    return a[:n * spf].reshape(n, spf).max(1)


def kept_fraction(peak, th_db, before, after):
    n = len(peak)
    if n == 0:
        return 0.0
    loud = peak > 10 ** (th_db / 20)
    out = loud.copy()
    idx = np.flatnonzero(loud)
    for s in range(1, round(before * FPS) + 1):
        out[np.clip(idx - s, 0, n - 1)] = True
    for s in range(1, round(after * FPS) + 1):
        out[np.clip(idx + s, 0, n - 1)] = True
    return out.mean()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("files", nargs="+")
    p.add_argument("--th", type=float, default=-30)
    p.add_argument("--before", type=float, default=0.3)
    p.add_argument("--after", type=float, default=0.5)
    args = p.parse_args()
    for f in args.files:
        peak = frame_peaks(f)
        k = kept_fraction(peak, args.th, args.before, args.after)
        mx = 20 * np.log10(peak.max() + 1e-12) if len(peak) else float("-inf")
        flag = "  <- no audio" if mx < -60 else ("  <- low keep, check" if k < 0.25 else "")
        print(f"{f:24s} peak {mx:6.1f} dB   kept {100 * k:5.1f}%{flag}")


if __name__ == "__main__":
    main()
