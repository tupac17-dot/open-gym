import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { confirmSheet } from '../sheets.jsx'
import { api } from '../lib/api.js'
import { effectiveRoutine, effectiveRoutineId, streakWeeks, lastBW, setsDoneActive } from '../lib/history.js'
import { fmtNum, fmtDate, todayISO, isoOf, weekKey, DAYS } from '../lib/format.js'
import { t, dateLocale } from '../lib/i18n.js'
import { bwSheet, goalSheet, dayOverrideSheet, calendarSheet, startFlow, loadStarterPlan, bwDeltaColor } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { glyphOf } from '../lib/glyphs.js'

function NotificationSheet({ onRead, close }) {
  const [items, setItems] = useState(null)
  const toast = useUI(s => s.toast)
  useEffect(() => { api('/api/notifications').then(d => setItems(d.notifications || [])).catch(e => toast(e.message || 'Could not load notifications')) }, [])
  const markRead = async id => {
    setItems(prev => prev?.map(n => n.id === id ? { ...n, readAt: n.readAt || new Date().toISOString() } : n))
    onRead?.()
    await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {})
  }
  return <>
    <div className="row between" style={{ marginBottom: 4 }}><div><h3 style={{ margin: 0 }}>Notifications</h3><div className="dim small">Admin announcements and workout alerts</div></div><button className="btn xs tinted" onClick={async () => { await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ all: true }) }).catch(() => {}); setItems(prev => prev?.map(n => ({ ...n, readAt: n.readAt || new Date().toISOString() }))); onRead?.() }}>Mark all read</button></div>
    <div className="list" style={{ gap: 6, maxHeight: '62vh', overflowY: 'auto', marginTop: 14 }}>
      {items === null && <div className="muted small">Loading…</div>}
      {items?.map(n => <button key={n.id} type="button" className={'item' + (!n.readAt ? ' acc' : '')} onClick={() => markRead(n.id)} style={{ padding: '11px 12px', borderRadius: 10, textAlign: 'left', cursor: 'pointer', border: !n.readAt ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}>
        <span className="lrow-i" style={{ background: !n.readAt ? 'var(--acc-soft)' : undefined }}><Icon name="bell" /></span>
        <div className="grow"><div style={{ fontWeight: n.readAt ? 500 : 700 }}>{n.title}</div><div className="small" style={{ fontWeight: n.readAt ? 400 : 600, marginTop: 3, whiteSpace: 'pre-wrap' }}>{n.body}</div><div className="dim" style={{ fontSize: '.72rem', marginTop: 5 }}>{new Date(n.created).toLocaleString()}</div></div>
        {!n.readAt && <span className="tag acc">New</span>}
      </button>)}
      {items?.length === 0 && <div className="empty small"><div className="ico"><Icon name="bell" /></div>No notifications yet.</div>}
    </div>
  </>
}

function NotificationBell({ user }) {
  const openSheet = useUI(s => s.openSheet)
  const [unread, setUnread] = useState(0)
  const load = () => api('/api/notifications').then(d => setUnread(d.unread || 0)).catch(() => {})
  useEffect(() => { if (!user) return; load(); const timer = setInterval(load, 30000); return () => clearInterval(timer) }, [user?.id])
  if (!user) return null
  return <button className="iconbtn notification-bell" onClick={() => openSheet(close => <NotificationSheet onRead={load} close={close} />)} aria-label={unread ? `${unread} unread notifications` : 'Notifications'} title="Notifications">
    <Icon name="bell" />{unread > 0 && <span className="notification-badge">{unread > 99 ? '99+' : unread}</span>}
  </button>
}

// Home = what to do now + a quick glance. Deep charts & history live in Stats.
export default function Home() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const appName = useStore(s => s.config.appName)
  const signOut = useStore(s => s.signOut)
  const toast = useUI(s => s.toast)
  const [weekOffset, setWeekOffset] = useState(0)
  const workouts = Array.isArray(S.workouts) ? S.workouts : []
  const bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : []
  const routines = Array.isArray(S.routines) ? S.routines : []
  const week = S.week && typeof S.week === 'object' ? S.week : {}
  const dayPlan = S.dayPlan && typeof S.dayPlan === 'object' ? S.dayPlan : {}

  const today = new Date()
  const routine = effectiveRoutine(S, todayISO())
  const todayOvr = dayPlan[todayISO()] !== undefined
  const bw = lastBW(S)
  const prevBW = bodyweight.length > 1 ? bodyweight[bodyweight.length - 2] : null
  const delta = bw && prevBW ? bw.w - prevBW.w : null

  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + weekOffset * 7)
  const doneDays = new Set(workouts.map(w => w.d))
  const strip = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i)
    const iso = isoOf(d)
    const eff = effectiveRoutineId(S, iso), ovr = dayPlan[iso] !== undefined, done = doneDays.has(iso)
    const dot = done ? ' done' : ovr && eff ? ' ovr' : eff ? ' plan' : ''
    strip.push(<div key={i} className={'wday' + (iso === todayISO() ? ' today' : '')} onClick={() => dayOverrideSheet(iso)}>
      <div className="lbl">{t(DAYS[d.getDay()])}</div><div className="num">{d.getDate()}</div><div className={'dot' + dot} /></div>)
  }
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
  const wkLabel = weekOffset === 0 ? t('This week') : `${monday.getDate()} ${monday.toLocaleDateString(dateLocale(), { month: 'short' })} – ${sunday.getDate()} ${sunday.toLocaleDateString(dateLocale(), { month: 'short' })}`

  const wThisWeek = workouts.filter(w => weekKey(w.d) === weekKey(todayISO())).length
  const plannedPerWeek = Object.keys(week).filter(k => week[k]).length
  const bwPoints = bodyweight.slice(-30).map(b => ({ t: b.t || new Date(b.d).getTime(), y: b.w, d: b.d }))

  // today's session shown right under the week strip
  const onToday = () => { if (S.active) nav('/workout'); else if (routine) startFlow(routine.id); else dayOverrideSheet(todayISO()) }
  const doSignOut = () => confirmSheet({ title: t('Sign out?'), message: t('Your data is synced to your profile first, then cleared from this device.'), confirmText: t('Sign out'), danger: true, onConfirm: async () => { await signOut(); nav('/home'); toast(t('Signed out')) } })

  return <div className="narrow">
    <div className="hdr">
      <div><h1>{user ? t('Hi {0}', user.name) : appName}</h1><div className="sub">{today.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
      <div className="row" style={{ gap: 5 }}>
        <NotificationBell user={user} />
        {user && <button className="iconbtn" onClick={doSignOut} aria-label={t('Sign out')}><Icon name="signOut" /></button>}
        <button className="iconbtn" onClick={() => nav('/settings')} aria-label={t('Settings')}><Icon name="gear" /></button>
      </div>
    </div>

    {user?.expiresAt && <div className="card" style={{ borderColor: user.expired ? 'var(--red)' : 'var(--yellow)', color: user.expired ? 'var(--red)' : 'var(--yellow)', marginBottom: 12 }}>
      <div className="row" style={{ gap: 8 }}><Icon name="clock" /><span>{user.expired ? t('Your invited account has expired.') : t('Invited account expires {0}.', new Date(user.expiresAt).toLocaleDateString())}</span></div>
      {!user.expired && user.canEditPlans === false && <div className="dim small" style={{ marginTop: 6 }}>{t('Plan and routine editing is disabled by an administrator.')}</div>}
    </div>}

    <div className="card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => setWeekOffset(w => w - 1)} aria-label="Previous week"><Icon name="chevronLeft" /></button>
        <div className="small muted" style={{ fontWeight: 500 }}>{wkLabel}</div>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => setWeekOffset(w => w + 1)} aria-label="Next week"><Icon name="chevronRight" /></button>
      </div>
      <div className="week">{strip}</div>
      <div className="today-row" onClick={onToday}>
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="lrow-i" style={{ background: S.active ? 'var(--orange)' : routine ? 'var(--acc)' : 'var(--surface-3)' }}>
            <Icon name={S.active ? 'timer' : routine ? glyphOf(routine.emoji) : 'moon'} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="lbl2">{t('Today')}</div>
            <div className="ttl">{S.active ? t('{0} — in progress', S.active.name) : routine ? routine.name : t('Rest day')}{todayOvr && routine ? ' · ' + t('rescheduled') : ''}</div>
          </div>
        </div>
        {S.active ? <span className="tag" style={{ color: 'var(--orange)', background: 'color-mix(in srgb,var(--orange) 16%,transparent)' }}>{t('Resume')}</span>
          : routine ? <span className="tag acc">{t('Start')}</span>
          : <Icon name="plus" className="chev" />}
      </div>
    </div>

    {!routines.length && !S.active && (
      <div className="card">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <span className="lrow-i"><Icon name="sparkles" /></span>
          <div className="big" style={{ fontSize: 22 }}>{t('Welcome!')}</div>
        </div>
        <div className="muted small" style={{ marginBottom: 12 }}>{t('Set up your weekly routine to get going — or load a ready-made Push / Pull / Legs plan.')}</div>
        <Button variant="primary" icon="sparkles" onClick={loadStarterPlan}>{t('Load starter plan (PPL)')}</Button>
        <div style={{ height: 8 }} /><Button onClick={() => nav('/plan')}>{t('Build my own plan')}</Button>
      </div>
    )}

    <div className="card">
      <div className="row between" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>{t('Body weight')}</h2>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" icon="target" style={S.targetW ? { color: 'var(--yellow)' } : undefined} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
          <Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>
        </div>
      </div>
      {bw ? <>
        <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <div className="big">{fmtNum(bw.w)} <span className="muted" style={{ fontSize: '1rem' }}>{S.unit}</span></div>
          {/* only when it actually moved — an unchanged weight used to read as "− 0" */}
          {!!delta && (
            <span className="small row" style={{ gap: 2, fontWeight: 500, color: bwDeltaColor(delta, bw.w) }}>
              <Icon name={delta > 0 ? 'arrowUp' : 'arrowDown'} style={{ fontSize: 12 }} />
              {fmtNum(Math.abs(delta))}
            </span>
          )}
          <span className="dim small" style={{ marginLeft: 'auto' }}>{fmtDate(bw.d, true)}</span>
        </div>
        {S.targetW && (
          <div className="small row" style={{ color: 'var(--yellow)', marginTop: 4, gap: 5 }}>
            <Icon name="target" style={{ fontSize: 13 }} />
            <span>{t('Goal')} {fmtNum(S.targetW)} {S.unit} · {Math.abs(S.targetW - bw.w) < 0.05 ? t('reached!') : t(S.targetW > bw.w ? '{0} to gain' : '{0} to lose', fmtNum(Math.abs(S.targetW - bw.w)) + ' ' + S.unit)}</span>
          </div>
        )}
        <div className="chart" style={{ marginTop: 8 }}><LineChart points={bwPoints} h={130} unit={S.unit} goal={S.targetW} /></div>
      </> : <div className="muted small">{t("No entries yet — log your weight to start the curve. It's also asked before every workout.")}</div>}
    </div>

    <div className="card tappable" style={{ cursor: 'pointer' }} onClick={() => calendarSheet()}>
      <div className="row between">
        <div>
          <div className="row" style={{ gap: 7, fontSize: 22, fontWeight: 600, letterSpacing: '-.021em' }}>
            <Icon name="flame" style={{ color: 'var(--orange)' }} />
            {t('{0} week streak', streakWeeks(S))}
          </div>
          <div className="muted small" style={{ marginTop: 2 }}>{wThisWeek}{plannedPerWeek ? ' / ' + plannedPerWeek : ''} {t('this week')} · {t(workouts.length === 1 ? '{0} workout total' : '{0} workouts total', workouts.length)}</div>
        </div>
        <Icon name="calendar" className="chev" style={{ fontSize: 20 }} />
      </div>
    </div>
  </div>
}
