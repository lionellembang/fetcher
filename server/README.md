# downloadrecord — BINUS LMS lecture recordings

A small server that downloads the lecture recordings of your BINUS LMS classes
(Zoom, onsite *and* online). New recordings are detected as soon as they appear
and **downloaded from SharePoint** with Playwright. The dashboard also has an
**Open on SharePoint** link that fetches a fresh link on click and opens it in
your own browser.

Finding recordings uses the LMS's own HTTP API. A browser is used only to log
in to the LMS and to download recordings from SharePoint.

## How it works

```
every SCAN_INTERVAL_MINUTES (and on startup)
  └─ scan
       ├─ session : reuse the saved LMS session, or log in with Playwright
       │            (.env credentials) when it's missing / expired / rejected
       ├─ catalog : period → class components → classes → sessions
       ├─ recordings : ask the recording endpoint for each past session that had
       │               a Zoom meeting; 404 = not ready yet, re-checked next scan
       ├─ recording downloads : one Playwright browser → SharePoint sign-in →
       │                        browser download of each recording not on disk
       └─ store      : SQLite record of every item and its status

browser ── /d/<ACCESS_TOKEN> ──▶ dashboard (classes, sessions, recordings, files)
```

### Login

Whenever a login is needed, the server runs **Playwright with the credentials in
`.env`**:

- Every attempt is a **cold start**: a brand-new Chromium process, an empty
  browser context, and the full email + password sign-in. Nothing is reused
  from earlier attempts or runs.
- It signs in to BINUSMAYA, opens the LMS, and captures the headers from the
  first API request the LMS makes: the `Authorization` Bearer token and the
  role headers (`roleid`, `roid`, `rolename`, `academiccareer`, `institution`).
  These are saved to `data/session.json`.
- The token lasts **24h**. A new login happens only when the session is missing,
  past its expiry, or rejected with `401` (then one login and one retry).
- Only one login runs at a time. Each attempt has a timeout, and its browser
  process is killed afterwards, so browsers never pile up.

Everything after that is plain HTTP with those headers.

### Recording downloads

The LMS hands out recordings as SharePoint share links
(`binusianorg.sharepoint.com/sites/bm5-zoomN/_layouts/15/guestaccess.aspx?share=…`).
They aren't anonymous, and the LMS token doesn't sign you in to SharePoint, so
at the end of each scan the server downloads every recording that isn't on disk
yet in **one cold Playwright browser**:

1. Ask the LMS for a fresh `recordingUrl` (they last ~12h) and open it.
2. SharePoint redirects to the Microsoft sign-in; Playwright signs in with the
   `.env` credentials. This happens on the first recording only: the SharePoint
   cookies carry over to the rest of the batch.
3. The link lands on the video player (`stream.aspx?id=<file path>`). The file's
   name and size come from SharePoint's REST API with the same cookies.
4. Playwright downloads `<site>/_layouts/15/download.aspx?SourceUrl=<file path>`
   (falling back to the share link with `download=1`) into `<file>.part`,
   checks the size and renames it into place.

A recording that fails is marked `failed` (the reason shows on hover in the
dashboard) and retried on the next scan. A failed sign-in stops the batch and
leaves the items as they were. Signed in as the student, SharePoint always
allows the download.

Run just the recording downloads, without a full scan (uses what the last scan
found):

```bash
npm run recordings                 # every recording not on disk yet
npm run recordings -- <sessionId>  # one (or more) specific sessions
HEADFUL=true npm run recordings -- <sessionId>   # watch it
```

## The LMS API it uses

All calls carry the session headers. `{role}` is `Student`.

| Purpose | Request | Returns |
|---|---|---|
| Current period | `GET {course}/AcademicPeriod/RunningAndUpcoming` | periods; the one with `isActiveRunningPeriod` is "now". Its short `academicPeriod` code (e.g. `2610`) is used below. |
| Components | `GET {course}/Course/Period/{period}/ClassComponentList/Student` | e.g. `["LAB","LEC","TUT"]` |
| Classes | `GET {course}/Course/Period/{period}/Component/{component}/{role}` | `[{ classId, courseCode, courseName, classCode, … }]` |
| Sessions | `GET {course}/ClassSession/Class/{classId}/{role}` | `{ courseCode, courseTitleEn, sessions: [{ id, classSessionNumber, dateEnd, … }] }` |
| Session detail | `GET {course}/ClassSession/Session/{sessionId}/Resource/{role}?isWeb=true` | `{ deliveryMode, joinUrl, dateStart, … }`. Only called for sessions whose recording hasn't been found yet. |
| Recording | `GET {course}/ClassSessionContent/ZoomRecording/ClassSession/{sessionId}` | `{ recordingUrl, expiredDate }`, or `404` when there's no recording (yet) |
| Profile | `GET {profile}/UserProfile` | name, email, roles |

`{course}` = `https://apim-bm7-prod-web.azure-api.net/func-bm7-course-prod`,
`{profile}` = `https://apim-bm7-prod-web.azure-api.net/func-bm7-profile-prod`.

### What we learned about the data

- **Recordings exist for onsite classes too.** In a test of one period, 48 of 58
  past sessions with a Zoom meeting had a recording.
- **New recordings take a few days to appear.** Every `404` was one of the most
  recent sessions, while recordings from the start of term were still there.
  That's why `not yet` items are re-checked every scan.
- **Self-learning sessions** (`deliveryMode: "GSLC"`) have no Zoom meeting and
  never get a recording. Sessions without a `joinUrl` are skipped.
- **Recording links are short-lived.** `recordingUrl` is a SharePoint link
  generated on each call and valid for about 12h, so it's never stored; the
  downloader and the dashboard ask for a new one right before use. Opening it
  requires a Microsoft sign-in with your BINUS account.
- **Downloading works for the student account** (verified 2026-10-15). After
  sign-in the share link lands on the player for a file like
  `/sites/bm5-zoom8/zoomrecording/zoom/recording/RS1/2026-9-9/<meetingId>.mp4`;
  the REST API reports its size, and `download.aspx` serves it. Recordings are
  1080p H.264 + AAC MP4s, roughly 70–100 MB per class.

## Setup

Requires **Node ≥ 24** (built-in `node:sqlite`), or just use Docker.

```bash
npm install
npx playwright install chromium   # for the login
cp .env.example .env              # fill in BINUS_USERNAME, BINUS_PASSWORD and an ACCESS_TOKEN
```

Generate an access token:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Run

```bash
npm start        # server + scan on startup + scan every SCAN_INTERVAL_MINUTES
npm run scan     # one scan, no server
npm run recordings  # only download recordings the last scan found
npm run login    # force a fresh login (watch it with HEADFUL=true)
```

Then open the dashboard at `http://<host>:<PORT>/d/<ACCESS_TOKEN>`.

### Web UI and API

| Route | What |
|---|---|
| `GET /d/<token>` | Dashboard: one table per class, one row per session, with the downloaded recording and its SharePoint link. Has a **Scan now** button. |
| `GET /d/<token>/api/items` | JSON list of all recordings. Filter with `?status=…`, `&period=…`. |
| `POST /d/<token>/scan` | Start a scan now. Returns `202`; returns the running scan if one is already going. |
| `GET /d/<token>/recording/<sessionId>` | Redirects to a fresh recording link (`404` if there isn't one yet). |
| `GET /d/<token>/files/<path>` | A downloaded recording. |
| `GET /healthz` | `{ ok, lastScan, scanning, counts }` (no secrets). |

Any other token returns `404`.

Item statuses: `not_yet` (recording not available yet), `available` (found),
`downloaded` (file on disk), `failed` (last download failed; retried on the
next scan, with the error shown on hover).

### Where files go

```
downloads/
  2610/
    COMP6798001 Program Design Methods (LEC)/
      COMP6798001 LEC S01 recording.mp4
      COMP6798001 LEC S02 recording.mp4
```

## Config (`.env`)

| Key | Default | Notes |
|---|---|---|
| `BINUS_USERNAME` / `BINUS_PASSWORD` | — | used by the Playwright login |
| `HEADFUL` | `false` | `true` shows the login browser (debugging) |
| `ACCESS_TOKEN` | — | secret path segment for the UI/API |
| `PORT` | `3100` | server port |
| `SCAN_INTERVAL_MINUTES` | `360` | how often to scan |
| `PERIODS` | *(active period)* | comma-separated period codes, e.g. `2610,2520` |
| `DOWNLOAD_RECORDINGS` | `true` | download recordings from SharePoint (`false` = track and link only) |
| `RECORDING_TIMEOUT_MIN` | `90` | a single recording download longer than this is cancelled |
| `DOWNLOAD_DIR` | `./downloads` | where files go |
| `DATA_DIR` | `./data` | session + SQLite db |
| `LOGIN_MAX_ATTEMPTS` | `3` | cold-start login retries |
| `LOGIN_RETRY_DELAY_SEC` | `30` | delay between login retries |
| `LOGIN_ATTEMPT_TIMEOUT_SEC` | `300` | a login attempt longer than this is killed and retried |
| `TZ` | `Asia/Jakarta` | timezone |

## Docker

```bash
npm run compose:up     # build + start
npm run compose:down   # stop
```

The session and database live in the `downloadrecord-data` volume. Downloaded
files are bind-mounted to `./downloads` on the host. Compose sets
`shm_size: 1gb` and `init: true` so Chromium runs reliably.

The login runs headless with the password on every attempt, so the account must
not require an MFA prompt that a headless browser can't answer.

## Layout

| File | Role |
|---|---|
| `index.js` | Boots the server, the scan scheduler, and a startup scan. |
| `src/config.js` | Reads `.env`; resolves paths. |
| `src/browser.js` | Cold Chromium launch per login attempt / download batch + guaranteed shutdown. |
| `src/login.js` | Playwright login; captures the LMS API headers. |
| `src/session.js` | Saved session; logs in only when it's unusable; one login at a time. |
| `src/lms.js` | LMS HTTP client (session headers, `401` → re-login + retry once). |
| `src/scan.js` | The scan: catalog walk and recording detection, then recording downloads. |
| `src/recordings.js` | SharePoint recording downloads in Playwright (sign-in + browser download). |
| `src/store.js` | SQLite (`node:sqlite`) item store. |
| `src/server.js` / `src/page.js` | Express routes and the dashboard HTML. |

## Extending

The LMS front-end calls many more endpoints (attendance, announcements,
upcoming/ongoing classes, grades, assessments, forums). The same session headers
work for all of them. Some verified ones:

- `GET {course}/SessionAttendance/Class/{classId}/Student`: per-session attendance and absence limits
- `GET {course}/ClassSession/Upcoming/Student`, `…/Ongoing/Student`: next / current class
- `GET https://apim-bm7-prod-web.azure-api.net/func-bm7-notification-prod/Announcements/PageSize/{n}/PageNumber/{p}`: announcements
- `GET https://apim-bm7-prod-web.azure-api.net/func-gradeBook-prod/GradeBook/GetStudentGradebook/{classId}`: grades (returns `400` until the grading period opens)

Stick to `GET` requests. Many other endpoints change data.

## Security

`.env`, `data/session.json` (a live 24h token) and your downloads are
**gitignored**; never commit them. The dashboard and files are protected only
by the secret `ACCESS_TOKEN` in the URL, so treat that URL like a password and
put the server behind HTTPS if you expose it.
