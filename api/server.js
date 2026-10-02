/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
let db = { users: [], creds: [], subs: [], invites: [], plans: [], groups: [], settings: {}, notifications: [] };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.subs = db.subs || [];
db.invites = db.invites || [];
db.plans = db.plans || [];
db.groups = db.groups || [];
db.settings = db.settings || {};
db.notifications = db.notifications || [];
if (db.settings.invitedPlanEditingEnabled === undefined) db.settings.invitedPlanEditingEnabled = true;
if (typeof db.settings.appName !== 'string' || !db.settings.appName.trim()) db.settings.appName = 'openGym';
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
// True while nobody holds admin — gates the first-run "create your admin" bootstrap.
const hasAdmin = () => db.users.some(isAdmin);
const appName = () => String(db.settings.appName || 'openGym').trim().slice(0, 40) || 'openGym';
const isExpired = user => !!user?.expiresAt && new Date(user.expiresAt).getTime() <= Date.now();
function planFingerprint(state) {
  if (!state) return '';
  return JSON.stringify({ routines: state.routines || [], week: state.week || {}, dayPlan: state.dayPlan || {}, customEx: state.customEx || [], plans: state.plans || [], activePlanId: state.activePlanId || null, allRoutines: state.allRoutines || [] });
}
function canEditPlans(user) {
  if (!user || isAdmin(user) || !user.invitedBy) return true;
  if (isExpired(user)) return false;
  const overrides = [];
  if (user.planEditingOverride !== null && user.planEditingOverride !== undefined) overrides.push(!!user.planEditingOverride);
  for (const g of db.groups) if ((g.memberIds || []).includes(user.id) && g.planEditingEnabled !== undefined) overrides.push(!!g.planEditingEnabled);
  if (overrides.includes(false)) return false;
  if (overrides.includes(true)) return true;
  return db.settings.invitedPlanEditingEnabled !== false;
}
function publicUser(user) {
  return { id: user.id, name: user.name, admin: isAdmin(user), invited: !!user.invitedBy, expiresAt: user.expiresAt || null, expired: isExpired(user), canEditPlans: canEditPlans(user) };
}
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
const challenges = new Map(); // cid -> {challenge, name?, uid?, exp}
function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY, appName: appName(), needs_admin: !hasAdmin() }),

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: publicUser(user) });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    // First-run bootstrap: the very first profile may claim admin, but only while none exists.
    const wantsAdmin = body.admin === true;
    if (wantsAdmin && hasAdmin()) return json(res, 409, { error: 'an admin already exists' });
    const code = String(body.code || '').trim().toUpperCase();
    // The bootstrap admin bypasses invite-only — there's no admin yet to mint a code.
    if (INVITE_ONLY && !wantsAdmin && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked))
      return json(res, 403, { error: 'a valid invite code is required' });
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: appName() || RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge, name, uid, code, admin: wantsAdmin });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || !c.uid) return json(res, 400, { error: 'challenge expired — try again' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    const { credential } = verification.registrationInfo;
    if (db.creds.find(x => x.id === credential.id)) return json(res, 409, { error: 'credential already registered' });
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    // The bootstrap admin skips this — it's the account that would otherwise issue the codes.
    let invite = null;
    if (INVITE_ONLY && !c.admin) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
      if (!invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString(), planEditingOverride: null, expiresAt: null };
    // Re-check at verify: if two people raced the bootstrap, the first to finish wins and the
    // loser is still created as a regular profile (avoids an orphaned passkey on their device).
    if (c.admin && !hasAdmin()) user.admin = true;
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || []
    });
    if (invite?.plan) {
      const plan = invite.plan;
      const initialState = {
        unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
        theme: 'dark', accent: 'lime', body: 'male', targetW: null,
        bodyweight: [],
        routines: Array.isArray(plan.routines) ? plan.routines : [],
        week: (typeof plan.week === 'object' && plan.week) ? plan.week : {},
        dayPlan: {},
        exWeights: {},
        workouts: [],
        customEx: Array.isArray(plan.customEx) ? plan.customEx : [],
        gifSize: 'full',
        reminder: { on: false, time: '08:00', tz: null },
        effort: null,
        _ts: Date.now()
      };
      atomicWrite(stateFile(user.id), JSON.stringify(initialState));
    }
    saveDb();
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c) return json(res, 400, { error: 'challenge expired — try again' });
    const cred = db.creds.find(x => x.id === body.credential?.id);
    if (!cred) return json(res, 404, { error: 'unknown passkey — create a profile first' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    cred.counter = verification.authenticationInfo.newCounter;
    saveDb();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) return json(res, 500, { error: 'user missing' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      json(res, 200, { state });
    } catch { json(res, 200, { state: null }); }
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    if (!canEditPlans(user)) {
      const current = readState(user.id) || {};
      if (planFingerprint(current) !== planFingerprint(body.state)) return json(res, 403, { error: 'plan and routine editing is disabled by an administrator' });
    }
    delete body.state.active;              // in-progress workouts stay device-local
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: appName(), body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        expiresAt: u.expiresAt || null, expired: isExpired(u), canEditPlans: canEditPlans(u),
        planEditingOverride: u.planEditingOverride === undefined ? null : u.planEditingOverride,
        groups: db.groups.filter(g => (g.memberIds || []).includes(u.id)).map(g => ({ id: g.id, name: g.name, planEditingEnabled: g.planEditingEnabled })),
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  'GET /api/notifications': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const notifications = db.notifications.filter(n => n.userId === user.id).sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 100);
    json(res, 200, { notifications, unread: notifications.filter(n => !n.readAt).length });
  },

  'POST /api/notifications/read': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const now = new Date().toISOString();
    let count = 0;
    for (const n of db.notifications) {
      if (n.userId !== user.id || n.readAt) continue;
      if (body.all || (body.id && n.id === body.id)) { n.readAt = now; count++; }
    }
    if (count) saveDb();
    json(res, 200, { ok: true, count });
  },

  'GET /api/admin/settings': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { settings: { invitedPlanEditingEnabled: db.settings.invitedPlanEditingEnabled !== false, appName: appName() } });
  },

  'PUT /api/admin/settings': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    if (body.invitedPlanEditingEnabled !== undefined) db.settings.invitedPlanEditingEnabled = !!body.invitedPlanEditingEnabled;
    if (body.appName !== undefined) {
      const name = String(body.appName || '').trim().slice(0, 40);
      if (!name) return json(res, 400, { error: 'app name required' });
      db.settings.appName = name;
    }
    saveDb();
    json(res, 200, { settings: { invitedPlanEditingEnabled: db.settings.invitedPlanEditingEnabled !== false, appName: appName() } });
  },

  'GET /api/admin/groups': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { groups: db.groups.map(g => ({ ...g, memberIds: g.memberIds || [], members: (g.memberIds || []).map(id => db.users.find(u => u.id === id)?.name).filter(Boolean) })) });
  },

  'POST /api/admin/groups': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return json(res, 400, { error: 'group name required' });
    if (db.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'group already exists' });
    const group = { id: 'grp_' + crypto.randomBytes(6).toString('hex'), name, planEditingEnabled: body.planEditingEnabled !== false, memberIds: [] };
    db.groups.push(group); saveDb(); json(res, 200, { group });
  },

  'PUT /api/admin/groups': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req); const g = db.groups.find(x => x.id === body.id);
    if (!g) return json(res, 404, { error: 'group not found' });
    if (body.name !== undefined) g.name = String(body.name).trim().slice(0, 60) || g.name;
    if (body.planEditingEnabled !== undefined) g.planEditingEnabled = !!body.planEditingEnabled;
    if (Array.isArray(body.memberIds)) g.memberIds = [...new Set(body.memberIds.filter(id => db.users.some(u => u.id === id)))];
    saveDb(); json(res, 200, { group: g });
  },

  'DELETE /api/admin/groups': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req); const before = db.groups.length;
    db.groups = db.groups.filter(g => g.id !== body.id);
    if (db.groups.length === before) return json(res, 404, { error: 'group not found' });
    saveDb(); json(res, 200, { ok: true });
  },

  'PUT /api/admin/user/permissions': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req); const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (body.planEditingOverride !== undefined && body.planEditingOverride !== null && typeof body.planEditingOverride !== 'boolean') return json(res, 400, { error: 'planEditingOverride must be true, false, or null' });
    u.planEditingOverride = body.planEditingOverride === undefined ? null : body.planEditingOverride;
    saveDb(); json(res, 200, { ok: true, user: publicUser(u) });
  },

  'PUT /api/admin/user/expiry': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req); const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (body.expiresAt) { const d = new Date(body.expiresAt); if (Number.isNaN(d.getTime())) return json(res, 400, { error: 'invalid expiration date' }); u.expiresAt = d.toISOString(); }
    else u.expiresAt = null;
    u.sv = sessionVersion(u) + 1; saveDb(); json(res, 200, { ok: true, user: publicUser(u) });
  },

  'PUT /api/admin/user/role': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req); const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const makeAdmin = !!body.admin;
    if (!makeAdmin && u.id === admin.id) return json(res, 400, { error: 'cannot remove your own admin access' });
    if (!makeAdmin && isAdmin(u) && db.users.filter(isAdmin).length <= 1) return json(res, 400, { error: 'cannot remove the last admin' });
    u.admin = makeAdmin; saveDb(); json(res, 200, { ok: true, user: publicUser(u) });
  },

  'POST /api/admin/notifications': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 100), message = String(body.body || '').trim().slice(0, 500);
    if (!title || !message) return json(res, 400, { error: 'title and body are required' });
    let ids = db.users.map(u => u.id);
    if (body.userIds) ids = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
    if (body.groupIds) {
      const selected = new Set(body.groupIds);
      ids = db.groups.filter(g => selected.has(g.id)).flatMap(g => g.memberIds || []);
    }
    ids = [...new Set(ids)].filter(id => db.users.some(u => u.id === id));
    const payload = { title, body: message, tag: String(body.tag || 'admin-broadcast').slice(0, 50), url: String(body.url || '/').slice(0, 200) };
    const created = new Date().toISOString();
    for (const userId of ids) db.notifications.push({ id: 'ntf_' + crypto.randomBytes(8).toString('hex'), userId, title, body: message, tag: payload.tag, url: payload.url, created, readAt: null });
    saveDb();
    await Promise.all(ids.map(id => sendPush(id, payload)));
    json(res, 200, { ok: true, targeted: ids.length, subscribed: ids.filter(id => db.subs.some(s => s.userId === id)).length });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: { ...publicUser(u), created: u.created || null, disabled: !!u.disabled, invitedBy: u.invitedBy || null, planEditingOverride: u.planEditingOverride === undefined ? null : u.planEditingOverride },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      week: S.week || {},
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length, ex: r.ex || [] })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/plan': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const plan = body.plan;
    if (!plan || typeof plan !== 'object') return json(res, 400, { error: 'valid plan required' });

    let S = readState(u.id);
    if (!S) {
      S = {
        unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
        theme: 'dark', accent: 'lime', body: 'male', targetW: null,
        bodyweight: [], routines: [], week: {}, dayPlan: {},
        exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
        reminder: { on: false, time: '08:00', tz: null }, effort: null
      };
    }
    
    const mode = body.mode || 'replace';
    const newRoutines = Array.isArray(plan.routines) ? plan.routines : [];
    const newWeek = (typeof plan.week === 'object' && plan.week) ? plan.week : {};
    const newCustomEx = Array.isArray(plan.customEx) ? plan.customEx : [];

    if (mode === 'replace') {
      S.routines = newRoutines;
      S.week = newWeek;
    } else {
      S.routines = (S.routines || []).concat(newRoutines);
      S.week = { ...(S.week || {}), ...newWeek };
    }

    S.customEx = S.customEx || [];
    for (const c of newCustomEx) {
      if (c && c.id && !S.customEx.some(x => x.id === c.id)) {
        S.customEx.push(c);
      }
    }

    S._ts = Date.now();
    atomicWrite(stateFile(u.id), JSON.stringify(S));
    json(res, 200, { ok: true, routines: S.routines.length });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i,
      usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null,
      planName: i.plan?.name || (i.plan ? (i.plan.routines?.length ? `${i.plan.routines.length} routines` : 'Custom plan') : null)
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register/options tells a caller whether a code is
    // good, so the code itself has to be the thing that isn't worth guessing. Codes already in
    // db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = {
      code,
      note: String(body.note || '').slice(0, 60),
      createdBy: admin.id,
      created: new Date().toISOString(),
      plan: (body.plan && typeof body.plan === 'object') ? body.plan : null
    };
    db.invites.push(invite);
    saveDb();
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    json(res, 200, { ok: true });
  },

  /* ---------- admin plan templates library ---------- */
  'GET /api/admin/plans': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const plans = (db.plans || []).map(p => ({
      ...p,
      routineCount: (p.routines || []).length,
      scheduledDays: Object.keys(p.week || {}).filter(k => p.week[k]).length
    }));
    json(res, 200, { plans });
  },

  'POST /api/admin/plans': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const id = 'plan_' + crypto.randomBytes(6).toString('hex');
    const name = String(body.name || 'Untitled Plan').trim().slice(0, 60);
    const description = String(body.description || '').trim().slice(0, 200);
    const routines = Array.isArray(body.routines) ? body.routines : [];
    const week = (typeof body.week === 'object' && body.week) ? body.week : {};
    const customEx = Array.isArray(body.customEx) ? body.customEx : [];
    const plan = {
      id,
      name,
      description,
      routines,
      week,
      customEx,
      createdBy: admin.id,
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };
    db.plans = db.plans || [];
    db.plans.push(plan);
    saveDb();
    json(res, 200, { plan });
  },

  'PUT /api/admin/plans': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    db.plans = db.plans || [];
    const plan = db.plans.find(p => p.id === body.id);
    if (!plan) return json(res, 404, { error: 'plan not found' });
    if (body.name !== undefined) plan.name = String(body.name).trim().slice(0, 60);
    if (body.description !== undefined) plan.description = String(body.description).trim().slice(0, 200);
    if (Array.isArray(body.routines)) plan.routines = body.routines;
    if (typeof body.week === 'object' && body.week) plan.week = body.week;
    if (Array.isArray(body.customEx)) plan.customEx = body.customEx;
    plan.updated = new Date().toISOString();
    saveDb();
    json(res, 200, { plan });
  },

  'DELETE /api/admin/plans': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    db.plans = db.plans || [];
    const idx = db.plans.findIndex(p => p.id === body.id);
    if (idx === -1) return json(res, 404, { error: 'plan not found' });
    db.plans.splice(idx, 1);
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/admin/plans/clone-routine': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    db.plans = db.plans || [];
    const targetPlan = db.plans.find(p => p.id === body.targetPlanId);
    if (!targetPlan) return json(res, 404, { error: 'target plan not found' });

    let sourceRoutine = null;
    if (body.sourcePlanId) {
      const sourcePlan = db.plans.find(p => p.id === body.sourcePlanId);
      if (sourcePlan && Array.isArray(sourcePlan.routines)) {
        sourceRoutine = sourcePlan.routines.find(r => r.id === body.routineId);
      }
    } else if (body.routine && typeof body.routine === 'object') {
      sourceRoutine = body.routine;
    }

    if (!sourceRoutine) return json(res, 404, { error: 'source routine not found' });

    const newRoutineId = 'r_' + crypto.randomBytes(6).toString('hex');
    const clonedRoutine = {
      ...JSON.parse(JSON.stringify(sourceRoutine)),
      id: newRoutineId,
      name: body.name || sourceRoutine.name || 'Cloned Routine'
    };

    targetPlan.routines = targetPlan.routines || [];
    targetPlan.routines.push(clonedRoutine);
    targetPlan.updated = new Date().toISOString();
    saveDb();
    json(res, 200, { ok: true, plan: targetPlan, routine: clonedRoutine });
  }
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`gym-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`));
