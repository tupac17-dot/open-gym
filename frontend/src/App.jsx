import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI } from './components/ui.jsx'
import { ACCENTS } from './lib/format.js'
import { setLang, useLang } from './lib/i18n.js'
import { setNav } from './lib/nav.js'
import { useWakeLock } from './lib/wakelock.js'
import { startFlow } from './sheets.jsx'
import Icon from './components/Icon.jsx'
import { Button } from './components/ui.jsx'
import TabBar from './components/TabBar.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Modals from './components/Modals.jsx'
import Toast from './components/Toast.jsx'
import RestTimer from './components/RestTimer.jsx'
import { pushSupported, enablePush, refreshPushSubscription } from './lib/push.js'
import Login from './views/Login.jsx'
import Home from './views/Home.jsx'
import Plan from './views/Plan.jsx'
import RoutineEdit from './views/RoutineEdit.jsx'
import Workout from './views/Workout.jsx'
import Stats from './views/Stats.jsx'
import History from './views/History.jsx'
import Library from './views/Library.jsx'
import Settings from './views/Settings.jsx'
import Admin from './views/Admin.jsx'

bindUI(useUI)   // lets the shared controls open sheets without importing the store at module scope

function LoginPushPrompt({ user }) {
  const toast = useUI(s => s.toast)
  const appName = useStore(s => s.config.appName)
  const [show, setShow] = useState(false)
  useEffect(() => {
    let live = true
    if (!user || !pushSupported()) { setShow(false); return () => { live = false } }
    navigator.serviceWorker.ready.then(async reg => {
      const sub = await reg.pushManager.getSubscription()
      if (sub) { await refreshPushSubscription().catch(() => {}); return }
      if (live && Notification.permission === 'default') setShow(true)
    }).catch(() => {})
    return () => { live = false }
  }, [user?.id])
  if (!show) return null
  const activate = async () => {
    try { await enablePush(); setShow(false); toast('Notifications enabled') }
    catch (e) { setShow(false); if (Notification.permission !== 'denied') toast(e.message || 'Could not enable notifications') }
  }
  return <div className="push-prompt" role="dialog" aria-live="polite">
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}><span className="lrow-i" style={{ background: 'var(--acc-soft)', color: 'var(--acc)' }}><Icon name="bell" /></span><div className="grow"><div style={{ fontWeight: 600 }}>Enable notifications?</div><div className="dim small">Get admin announcements and workout alerts even when {appName} is not the active tab.</div></div><button className="iconbtn" onClick={() => setShow(false)} aria-label="Dismiss"><Icon name="xmark" /></button></div>
    <Button variant="primary" size="sm" icon="bell" onClick={activate} style={{ width: '100%', marginTop: 10 }}>Enable notifications</Button>
  </div>
}

function applyPrefs(theme, accent) {
  const de = document.documentElement
  de.dataset.theme = theme === 'light' ? 'light' : 'dark'
  de.dataset.accent = ACCENTS[accent] ? accent : 'lime'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = de.dataset.theme === 'light' ? '#f2f2f7' : '#000000'
}

function Shell() {
  const navigate = useNavigate()
  const loc = useLocation()
  const { S, user, ready } = useStore()
  const appName = useStore(s => s.config.appName)
  const isGuest = useStore(s => s.isGuest())
  const langV = useLang()   // re-renders the whole shell when the language (pack) changes
  useEffect(() => { setNav(navigate) }, [navigate])
  useEffect(() => { applyPrefs(S.theme, S.accent) }, [S.theme, S.accent])
  useEffect(() => { setLang(S.lang || 'en') }, [S.lang])
  useEffect(() => { document.documentElement.lang = S.lang || 'en' }, [langV, S.lang])
  useEffect(() => { document.title = appName }, [appName])
  // every tab/route change starts at the top of the page
  useEffect(() => {
    // Sheets are global UI state. Closing an admin detail/editor sheet when changing tabs
    // prevents its backdrop from covering the destination page and leaving the body locked.
    useUI.getState().closeAll()
    document.body.style.position = document.body.style.top = document.body.style.left = document.body.style.right = document.body.style.width = ''
    window.scrollTo(0, 0)
  }, [loc.pathname])
  // bound to the workout, not to the route — checking Stats mid-session keeps the screen on
  useWakeLock(!!S.active && S.keepAwake !== false)

  const authed = user || isGuest
  if (!ready && !authed) return (
    <div id="app">
      <div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', fontSize: 34, color: 'var(--label-3)' }}>
        <Icon name="dumbbell" />
      </div>
    </div>
  )

  return (
    <>
      {/* Keep the app container mounted while changing tabs. Only reset the error boundary
          per route, so Admin → Home cannot leave a transient empty #app during remount. */}
      <div id="app" className="vfade">
        <ErrorBoundary key={loc.pathname}>
          {!authed ? <Login /> : (
            <Routes>
              <Route path="/home" element={<Home />} />
              <Route path="/plan" element={<Plan />} />
              <Route path="/plan/r/:id" element={<RoutineEdit />} />
              <Route path="/workout" element={<Workout />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/history" element={<History />} />
              <Route path="/library" element={<Library />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/admin" element={user?.admin ? <Admin /> : <Navigate to="/home" replace />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          )}
        </ErrorBoundary>
      </div>
      <TabBar onStart={startFlow} />
      <LoginPushPrompt user={user} />
      <RestTimer />
      <Modals />
      <Toast />
    </>
  )
}

export default function App() {
  const boot = useStore(s => s.boot)
  useEffect(() => { boot() }, [boot])
  return <HashRouter><Shell /></HashRouter>
}
