import { create } from 'zustand'
import { api } from '../lib/api.js'
import { localTZ } from '../lib/format.js'
import { registerCustom } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'
import { ensureUserPlans, syncActivePlan } from '../lib/plan-manager.js'

const KEY = 'gym_state_v1'
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null,
  plans: [], activePlanId: null, allRoutines: []
}
const DEFAULT_CONFIG = { appName: 'openGym', invite_only: false, admin_code: false }
const clone = o => JSON.parse(JSON.stringify(o))
const normalizeConfig = c => ({ ...DEFAULT_CONFIG, ...(c || {}), appName: String(c?.appName || DEFAULT_CONFIG.appName).trim() || DEFAULT_CONFIG.appName })

function normalizeState(S) {
  const next = Object.assign(clone(DEF), S || {})
  for (const key of ['bodyweight', 'routines', 'workouts', 'customEx', 'plans', 'allRoutines']) {
    if (!Array.isArray(next[key])) next[key] = []
  }
  for (const key of ['week', 'dayPlan', 'exWeights']) {
    if (!next[key] || typeof next[key] !== 'object' || Array.isArray(next[key])) next[key] = {}
  }
  if (next.active && !Array.isArray(next.active.entries)) next.active = { ...next.active, entries: [] }
  if (!next.reminder || typeof next.reminder !== 'object' || Array.isArray(next.reminder)) next.reminder = clone(DEF.reminder)
  ensureUserPlans(next)
  return next
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      return normalizeState(JSON.parse(raw))
    }
  } catch (e) { /* ignore */ }
  return normalizeState()
}

const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length || (st.plans || []).length)
const planFingerprint = st => JSON.stringify({ routines: st.routines || [], week: st.week || {}, dayPlan: st.dayPlan || {}, customEx: st.customEx || [], plans: st.plans || [], activePlanId: st.activePlanId || null, allRoutines: st.allRoutines || [] })

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null

  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  const nativePersist = () => {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
  }

  const persist = (S, push = true) => {
    const next = normalizeState(S)
    syncActivePlan(next)
    next._ts = Date.now()
    registerCustom(next.customEx)
    localStorage.setItem(KEY, JSON.stringify(next))
    set({ S: next })
    if (MOBILE) nativePersist()
    if (push && get().user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    if (MOBILE && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSave(get().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      get().pushState()
    }
  })

  // Everything a sign-out leaves behind on this device, whichever way it was triggered.
  // IMPORTANT: we must NOT call persist() here because persist runs ensureUserPlans
  // which auto-creates a default "My Plan" and stamps _ts = Date.now(). That fresh
  // timestamp would make pullState think the local (empty) state is newer than the
  // server copy, so the real data would be silently discarded on next login.
  const clearLocalSession = () => {
    get().setUser(null)
    localStorage.removeItem('gym_guest')
    localStorage.removeItem('gym_dirty')
    localStorage.removeItem(KEY)
    const fresh = clone(DEF)
    // No _ts — pullState must see this as "no data" so it always accepts the server copy
    delete fresh._ts
    set({ S: fresh })
  }

  return {
    S: (() => { const s = loadState(); registerCustom(s.customEx); return s })(),
    user: (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })(),
    config: DEFAULT_CONFIG,
    ready: false,

    setConfig(c) { set(s => ({ config: normalizeConfig({ ...s.config, ...c }) })) },
    async loadConfig() {
      const c = await api('/api/config')
      get().setConfig(c)
      return c
    },

    // Mutate a draft of S via producer fn, then persist + schedule sync.
    update(mut, push = true) {
      const S = clone(get().S)
      const before = planFingerprint(S)
      mut(S)
      const u = get().user
      if (u?.invited && u.canEditPlans === false && planFingerprint(S) !== before) return
      persist(S, push)
    },
    replaceState(S, push = false) {
      const next = clone(S), u = get().user
      if (u?.invited && u.canEditPlans === false && planFingerprint(next) !== planFingerprint(get().S)) return
      persist(normalizeState(next), push)
    },

    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    setUser(u) {
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      set({ user: u })
    },

    async pushState() {
      if (!get().user) return
      clearTimeout(pushTm)
      try { await api('/api/data', { method: 'PUT', body: JSON.stringify({ state: get().S }) }); localStorage.removeItem('gym_dirty') }
      catch (e) { localStorage.setItem('gym_dirty', '1') }
    },
    async pullState() {
      try {
        const { state } = await api('/api/data')
        const S = get().S
        const dirty = localStorage.getItem('gym_dirty') === '1'
        if (state && (!hasData(S) || ((state._ts || 0) >= (S._ts || 0) && !dirty))) {
          const active = S.active
          const next = normalizeState(state)
          if (active) next.active = active
          persist(next, false)
        } else if (hasData(S)) { await get().pushState() }
      } catch (e) { /* offline — keep local */ }
    },

    async signOut() {
      try { await get().pushState(); await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { /* */ }
      clearLocalSession()
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it. Unlike signOut the request is NOT swallowed: if it fails
    // the sessions elsewhere are all still valid, and wiping this device's copy of the data
    // would sign the user out of the one place the bump didn't reach. Caller reports the error.
    async signOutAll() {
      await get().pushState()   // never throws — stores gym_dirty and moves on when offline
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      clearLocalSession()
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      localStorage.removeItem('gym_dirty')
      persist(Object.assign(clone(DEF), buildDemoState()), false)
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Mobile build: no backend either — restore from the file mirror (the durable copy;
      // localStorage may have been evicted since the last run) and go straight in.
      if (MOBILE) {
        const saved = await nativeLoad()
        const S = get().S
        if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
          persist(Object.assign(clone(DEF), saved), false)
        } else if (hasData(S)) {
          nativeSave(S)   // first run after an update from a file-less version: seed the mirror
        }
        get().setGuest(true)
        syncReminder(get().S)
        set({ ready: true })
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        set({ ready: true })
        return
      }
      await get().loadConfig().catch(() => {})
      try {
        const me = await api('/api/me')
        get().setUser(me.user)
        await get().pullState()
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings.
        const tz = localTZ()
        if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      } catch (e) {
        if (e.status === 401) get().setUser(null)
      }
      set({ ready: true })
    }
  }
})

export { hasData }
