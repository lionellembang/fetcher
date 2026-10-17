# gapless-pipeline

Batch silence-cutting for lecture recordings, using **auto-editor** (the engine behind the Gapless Mac app). This is the "cut" stage of a planned discover → cut → transcribe program; this README doubles as the reference notes from the first full run (Oct 8–10, 2026).

## Quick start

Requirements: macOS, `auto-editor` (`brew install auto-editor`, or the copy inside Gapless.app). For the prediction tool: Python 3, `numpy`, `ffmpeg`.

```bash
# cut every recording in ~/Recordings (or pass another folder)
caffeinate -i bash gapless_batch.sh [~/Recordings]

# predict how much each file will keep, without encoding (seconds per file)
python3 tools/predict_cuts.py --th -30 --before 0.3 --after 0.5 ~/Recordings/*.mp4
```

Parameters (`EDIT`, `MARGIN`, `TEST`) are set at the top of `gapless_batch.sh`.

## Repo layout

```
gapless-pipeline/
├── gapless_batch.sh        ← batch cutter (discover → test → cut → summary)
├── tools/predict_cuts.py   ← kept-% predictor (§6)
├── README.md
├── logs/                   ← run logs            (git-ignored)
└── state/                  ← resume markers      (git-ignored)
    └── reprocessed_<edit>_<margin>   ← list of originals finished with those settings
```

---

## 1. What it does

Takes raw lecture recordings (`<RECORDINGS>/*.mp4`), removes silent stretches, and writes `<RECORDINGS>/cutted/<name> cutted.mp4`. Originals are never modified.

```
~/Recordings/
├── BDA 1.mp4, CN 1 lab.mp4, ...      ← originals (input, read-only)
├── SC 2_ALTERED.mp4                   ← old auto-editor default output, ignored
├── gapless-pipeline/                  ← this repo
└── cutted/
    ├── BDA 1 cutted.mp4, ...          ← outputs
    └── Archive.zip                    ← zip of the 36 cut files (Oct 11)
```

---

## 2. Tooling / environment

| Item | Value |
|---|---|
| Machine | Apple Silicon Mac |
| Cutter | `auto-editor` at `/opt/homebrew/bin/auto-editor` (Homebrew) |
| GUI | Gapless.app (`org.gapless.gapless`): front-end over auto-editor; shows the equivalent CLI command in the bottom-right status bar with a **Copy** button |
| Shell | macOS `/bin/bash` 3.2, so no `mapfile` or associative arrays; `stat -f%z` for file size |
| Keep-awake | run under `caffeinate -i` |

**Getting the command out of Gapless:** open any video. The status bar shows e.g.
`auto-editor ../../../../Recordings/CN 1.mp4 --edit audio:-19dB --margin 0.2s,0.2s`.
The text is truncated at the default window size, so make the window full screen to read it. The UI is a web view with no accessibility text. The path is relative to the app's working directory; ignore it and pass your own path.

**Why it runs on the Mac and not in a Linux sandbox:** auto-editor ≥ 29 ships as a prebuilt native binary (linux-x86_64, macos-arm64, macos-x86_64, windows). There is **no linux-arm64 build**, so it won't run on an aarch64 Linux box. A Linux VM would also lack VideoToolbox and be much slower.

---

## 3. Parameters

| Run | Command flags | Notes |
|---|---|---|
| Gapless saved settings (run 1, Oct 8) | `--edit audio:-19dB --margin 0.2s,0.2s` | Cut too aggressively: quiet recordings lost most of their content, and speech onsets/endings got clipped |
| **Current (run 2, Oct 10)** | `--edit audio:-30dB --margin 0.3s,0.5s` | Lower threshold keeps quiet speech; longer margins (esp. the trailing one) stop words being clipped |

Full per-file command:
```bash
auto-editor "<in>.mp4" --edit audio:-30dB --margin 0.3s,0.5s --no-open -o "cutted/.partial_<name> cutted.mp4"
```

- `--edit audio:<dB>`: a frame counts as "loud" if its peak sample amplitude is above the threshold. This is an absolute level, not relative to the file.
- `--margin <before>,<after>`: padding kept around each loud section. The *after* margin matters more because word endings trail off quietly.
- `--no-open`: otherwise auto-editor opens every output in the default player.
- `-o`: without it auto-editor writes `<name>_ALTERED.mp4` next to the input (that's where `SC 2_ALTERED.mp4` came from).
- Default encode: H.264 1080p25 + AAC 128 kb/s.

---

## 4. Batch logic (`gapless_batch.sh`)

1. **Locate auto-editor**: `command -v`, then search inside `Gapless.app`, then the Homebrew paths.
2. **Discover inputs**: `*.mp4` in the recordings folder (arg 1, default `~/Recordings`), excluding names ending in `cutted` or `_ALTERED`. (Run 1 also skipped originals that already had a `cutted` counterpart. Run 2 deliberately reprocessed everything.)
3. **Test first**: process one known-good file (`CN 1.mp4`) and abort the whole batch if it fails.
4. **Per file**:
   - write to `cutted/.partial_<name> cutted.mp4`;
   - success = exit code 0 **and** output > 100 KB → `mv -f` over the final name. This is an atomic replace: an old cut is only overwritten by a finished new one;
   - append the filename to `state/reprocessed_<edit>_<margin>`, so a re-run skips it (a new parameter set gets a new marker file, which means everything is redone);
   - `Error! Timeline is empty` → **SKIPPED (silent)**, not a failure; the batch continues;
   - any other failure: leave the old cut untouched and record it as failed.
5. **Logging**: auto-editor's progress bar writes thousands of `\r`-separated updates. The script captures output per file, strips the `⏳` lines, and appends only the last 20 lines to `logs/gapless_reprocess.log`. Without this the run-1 log (`logs/gapless_batch.log`) grew to 105 MB.
6. **Summary**: counts of done / silent / failed, plus the lists.

---

## 5. Silent-recording detection

Some recordings have a dead audio track (mic not captured). auto-editor fails on them with `Timeline is empty, nothing to do.`

Pre-check with ffmpeg (fast, audio-only decode):
```bash
ffmpeg -nostats -vn -i "file.mp4" -map 0:a:0 -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"
```

| File | max_volume | Result |
|---|---|---|
| PDM 2 | −90.3 dB | silent, skipped |
| PDM 3 | −80.8 dB | silent, skipped |
| PDM 4 | −13.0 dB (mean −48) | very quiet; 1 % kept at −19 dB, 31 % at −30 dB |
| all others | −6 … 0 dB | normal |

Suggested rule for the big pipeline: if `max_volume < -60 dB`, flag as **no audio** and skip both cutting and transcription. If `max_volume < threshold + ~10 dB`, flag as **quiet** for manual review.

---

## 6. Predicting cuts before encoding

Encoding is the slow part. `tools/predict_cuts.py` predicts the kept fraction in seconds by reproducing auto-editor's per-frame peak test in numpy. It decodes audio to 16 kHz mono, takes the peak per 1/25 s video frame, thresholds it, and dilates by the margins. This matched the real run-1 results to within ~1 %.

```bash
python3 tools/predict_cuts.py --th -30 --before 0.3 --after 0.5 ~/Recordings/*.mp4
# CN 1.mp4                 peak   -6.5 dB   kept  53.9%     (actual run 2: 56%)
# PDM 2.mp4                peak  -90.3 dB   kept   0.0%  <- no audio
```

It also flags files with no audio (peak < −60 dB) and files keeping under 25 %.

This is useful as an automatic sanity check. If the predicted kept fraction is under ~25 %, the threshold is probably wrong for that recording.

---

## 7. Results (run 2: −30 dB, 0.3s/0.5s)

Total: **62.7 h in → 36.3 h out (58 % kept)** across 36 files. Wall time ≈ 4 h 40 min (10:37 → 15:18), about 4–17 min per file.

| File | In (min) | Out (min) | Kept |
|---|---|---|---|
| BDA 1 | 96 | 61 | 64% |
| BDA 2 | 101 | 59 | 58% |
| BDA 3 | 92 | 49 | 53% |
| BDA 4 | 97 | 41 | 43% |
| CBA 1 | 105 | 81 | 77% |
| CBA 2 | 118 | 59 | 50% |
| CBA 3 | 112 | 74 | 66% |
| CBA 4 | 127 | 49 | 38% |
| CN 1 | 115 | 64 | 56% |
| CN 1 lab | 120 | 83 | 69% |
| CN 2 | 206 | 77 | 37% |
| CN 2 lab | 113 | 60 | 53% |
| DMO 1 | 95 | 75 | 79% |
| DMO 2 | 75 | 53 | 71% |
| DMO 3 | 84 | 42 | 50% |
| DT 1 | 99 | 84 | 85% |
| DT 1 lab | 97 | 58 | 59% |
| DT 2 | 103 | 21 | 21% |
| DT 2 lab | 112 | 55 | 49% |
| DT 3 | 101 | 87 | 86% |
| DT 4 | 109 | 84 | 77% |
| I 1 | 102 | 66 | 65% |
| I 2 | 99 | 58 | 58% |
| I 3 | 74 | 51 | 68% |
| IDS 1 | 97 | 80 | 83% |
| IDS 2 | 79 | 14 | 18% |
| ML 1 | 113 | 64 | 57% |
| ML 2 | 107 | 57 | 54% |
| ML 3 | 98 | 49 | 50% |
| PDM 1 | 88 | 48 | 55% |
| PDM 2 | 88 | – | silent |
| PDM 3 | 112 | – | silent |
| PDM 4 | 107 | 34 | 31% |
| SC 1 | 117 | 78 | 66% |
| SC 1 lab | 99 | 48 | 49% |
| SC 2 | 105 | 87 | 83% |
| SC 2 lab | 110 | 57 | 52% |
| SC 3 | 88 | 71 | 81% |

Low outliers DT 2 (21 %) and IDS 2 (18 %) barely changed between −19 dB and −35 dB in simulation. They are probably mostly empty recordings (class ended early or recording left running), not a threshold problem. Worth a manual check.

---

## 8. Gotchas / lessons

- **Pick the test file by audio level, not file size.** The smallest file (PDM 2) was the silent one, so the first test run failed.
- **"Timeline is empty"** = nothing above the threshold. Treat it as a skip, not an error.
- **Detect the silent case from the per-file output, not the tail of a shared log.** The run-1 check looked at the last 400 bytes of the log, and progress-bar escape codes pushed the message out, so PDM 3 was misreported as FAILED.
- **Write to a temp name, then rename.** Partial files never look finished, and replacing old cuts is safe.
- **Resume marker keyed by parameters** (`.reprocessed_<edit>_<margin>`), so changing parameters automatically means "redo everything".
- **Naming convention:** `<original stem> cutted.mp4`. Course code + session number (+ `lab`), e.g. `CN 2 lab`.
- auto-editor version differences: flags used here (`--edit`, `--margin`, `--no-open`, `-o`, `info`) are stable across recent versions. `--progress none` exists in 29.x but wasn't relied on.

---

## 9. Hooks for the full pipeline

Where this step sits in a discover → cut → transcribe program:

1. **Discover**: glob the recordings dir and apply the exclusion rules (`*cutted`, `*_ALTERED`, non-video). Key state by original filename + parameter set.
2. **Audio pre-check** (§5) → route silent files out early.
3. **Optional prediction** (§6) → flag outliers before spending encode time.
4. **Cut** (§3/§4) with atomic writes and a resume marker.
5. **Transcribe**: either the cut video or, more cheaply, the original audio. auto-editor can export the cut timeline as JSON instead of a video (`--export v1` or `v3`, or just `-o cuts.json`; checked against the 29.3.1 source), so original-file timestamps can be mapped onto the cut video. Transcribing the cut file is simpler; transcribing the original and remapping keeps timestamps for both versions.
6. **Report**: per-file in/out duration, kept %, status (done / silent / quiet / failed).
