/**
 * BINUS LMS HTTP client. Every call carries the headers captured at login
 * (Bearer token + role headers). On a 401 we log in once more and retry; a
 * second 401 is an error.
 *
 * See README.md for the endpoints and what each returns.
 */
const { getSession } = require('./session');

const COURSE = 'https://apim-bm7-prod-web.azure-api.net/func-bm7-course-prod';
const PROFILE = 'https://apim-bm7-prod-web.azure-api.net/func-bm7-profile-prod';
const ROLE = 'Student';

class HttpError extends Error {
  constructor(status, url, body) {
    super(`${status} for ${url.replace(/\?.*/, '')}${body ? ': ' + body.slice(0, 200) : ''}`);
    this.status = status;
  }
}

async function request(url, { retried = false } = {}) {
  const session = await getSession({ force: retried });
  const res = await fetch(url, {
    headers: { ...session.headers, accept: 'application/json', 'content-type': 'application/json' },
  });
  if (res.status === 401 && !retried) {
    console.log('→ Token rejected by the API — logging in again …');
    return request(url, { retried: true });
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  return text ? JSON.parse(text) : null;
}

/** Like request(), but a 404 means "not there" → null. */
async function requestOptional(url) {
  try {
    return await request(url);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

const enc = encodeURIComponent;

module.exports = {
  HttpError,
  userProfile: () => request(`${PROFILE}/UserProfile`),

  /** All periods; pick isActiveRunningPeriod for "now". */
  academicPeriods: () => request(`${COURSE}/AcademicPeriod/RunningAndUpcoming`),
  /** e.g. ["LAB","LEC","TUT"] — periodCode is the short code like "2610". */
  classComponents: (periodCode) =>
    request(`${COURSE}/Course/Period/${enc(periodCode)}/ClassComponentList/${ROLE}`),
  classes: (periodCode, component) =>
    request(`${COURSE}/Course/Period/${enc(periodCode)}/Component/${enc(component)}/${ROLE}`),
  /** { classCode, courseCode, courseTitleEn, sessions: [{ id, classSessionNumber, dateEnd, … }], … } */
  classDetail: (classId) => request(`${COURSE}/ClassSession/Class/${enc(classId)}/${ROLE}`),
  /** { topic, deliveryMode, joinUrl, dateStart, dateEnd, … } */
  sessionDetail: (sessionId) =>
    request(`${COURSE}/ClassSession/Session/${enc(sessionId)}/Resource/${ROLE}?isWeb=true`),
  /** { recordingUrl, expiredDate } or null when there's no recording (yet). */
  zoomRecording: (sessionId) =>
    requestOptional(`${COURSE}/ClassSessionContent/ZoomRecording/ClassSession/${enc(sessionId)}`),
};
