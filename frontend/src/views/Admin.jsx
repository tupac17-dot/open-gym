import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { fmtDate, fmtNum, fmtVol, fmtDur, DAYN, uid } from '../lib/format.js'
import { workoutVolume, setsDone } from '../lib/history.js'
import { starterRoutines } from '../lib/starter.js'
import { parsePlan } from '../lib/plan-share.js'
import { clonePlanObject, cloneRoutineObject } from '../lib/plan-manager.js'
import { t } from '../lib/i18n.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { glyphOf, DEFAULT_GLYPH } from '../lib/glyphs.js'

// Admin-only operator dashboard (owner passkey + admin flag; guarded again server-side).
// Deliberately English-only — it isn't part of the translated end-user surface, so it stays
// out of the per-language string packs.

const rel = ts => {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}
const dur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60) + 'm' }

/* ==================== Access, Groups & Broadcasts ==================== */
function GroupMembersSheet({ group, users, onSaved, close }) {
  const toast = useUI(s => s.toast)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(() => new Set(group.memberIds || []))
  const [saving, setSaving] = useState(false)
  const filtered = users.filter(u => {
    const q = query.trim().toLowerCase()
    return !q || u.name.toLowerCase().includes(q)
  })
  const toggle = id => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const save = async () => {
    setSaving(true)
    try {
      await api('/api/admin/groups', { method: 'PUT', body: JSON.stringify({ id: group.id, memberIds: [...selected] }) })
      toast('Group members updated')
      onSaved?.()
      close()
    } catch (e) { toast(e.message || 'Could not update group members') }
    finally { setSaving(false) }
  }
  return <>
    <h3 style={{ margin: '0 0 4px' }}>Add members</h3>
    <div className="dim small" style={{ marginBottom: 12 }}>Choose users for <strong style={{ color: 'var(--fg)' }}>{group.name}</strong>.</div>
    <input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search users…" style={{ marginBottom: 10 }} />
    <div className="list" style={{ gap: 5, maxHeight: '48vh', overflowY: 'auto', marginBottom: 14 }}>
      {filtered.map(u => {
        const checked = selected.has(u.id)
        return <button key={u.id} type="button" className={'item' + (checked ? ' acc' : '')} onClick={() => toggle(u.id)} style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: checked ? '1.5px solid var(--acc)' : '1px solid var(--sep)', textAlign: 'left' }}>
          <span className="lrow-i" style={{ background: checked ? 'var(--acc-soft)' : undefined }}><Icon name={checked ? 'check' : 'person'} /></span>
          <div className="grow"><div style={{ fontWeight: 600, fontSize: '.92rem' }}>{u.name}</div><div className="dim small">{u.admin ? 'Administrator' : `${u.workouts || 0} workouts`}</div></div>
          {checked && <Icon name="check" style={{ color: 'var(--acc)' }} />}
        </button>
      })}
      {!filtered.length && <div className="empty small">No users found.</div>}
    </div>
    <Button variant="primary" style={{ width: '100%' }} disabled={saving} onClick={save}>{saving ? 'Saving…' : `Save members (${selected.size})`}</Button>
  </>
}

function AdminControls({ users, reload }) {
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const setConfig = useStore(s => s.setConfig)
  const [settings, setSettings] = useState({ invitedPlanEditingEnabled: true, appName: 'openGym' })
  const [appNameDraft, setAppNameDraft] = useState('openGym')
  const [groups, setGroups] = useState([])
  const [recipient, setRecipient] = useState('all')
  const [selected, setSelected] = useState('')
  const [title, setTitle] = useState('openGym')
  const [message, setMessage] = useState('')
  const load = () => Promise.all([api('/api/admin/settings'), api('/api/admin/groups')]).then(([s, g]) => {
    setSettings(s.settings)
    setConfig(s.settings)
    setAppNameDraft(s.settings?.appName || 'openGym')
    setTitle(prev => prev === 'openGym' ? (s.settings?.appName || 'openGym') : prev)
    setGroups(g.groups || [])
  }).catch(e => toast(e.message))
  useEffect(() => { load() }, [])
  const toggleGlobal = async () => { try { const d = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ invitedPlanEditingEnabled: !settings.invitedPlanEditingEnabled }) }); setSettings(d.settings); setConfig(d.settings); reload() } catch (e) { toast(e.message) } }
  const saveAppName = async () => {
    const appName = appNameDraft.trim()
    if (!appName) return toast('Enter an app name')
    try {
      const d = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ appName }) })
      setSettings(d.settings)
      setConfig(d.settings)
      setAppNameDraft(d.settings.appName)
      setTitle(d.settings.appName)
      toast('App name updated')
      reload()
    } catch (e) { toast(e.message || 'Could not update app name') }
  }
  const createGroup = async () => { const name = window.prompt('Group name'); if (!name?.trim()) return; try { await api('/api/admin/groups', { method: 'POST', body: JSON.stringify({ name }) }); load(); toast('Group created') } catch (e) { toast(e.message) } }
  const updateGroup = async g => { try { await api('/api/admin/groups', { method: 'PUT', body: JSON.stringify({ id: g.id, planEditingEnabled: !g.planEditingEnabled }) }); load(); reload() } catch (e) { toast(e.message) } }
  const manageMembers = g => openSheet(close => <GroupMembersSheet group={g} users={users} onSaved={() => { load(); reload() }} close={close} />)
  const send = async () => {
    if (!message.trim()) return toast('Enter a notification message')
    const body = { title, body: message }
    if (recipient === 'user') body.userIds = [selected]
    if (recipient === 'group') body.groupIds = [selected]
    try { const d = await api('/api/admin/notifications', { method: 'POST', body: JSON.stringify(body) }); toast(`Notification targeted ${d.targeted} users (${d.subscribed} subscribed)`); setMessage('') } catch (e) { toast(e.message) }
  }
  return <>
    <h4 className="sec">App</h4>
    <div className="card">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>App name</div>
      <div className="dim small" style={{ marginBottom: 10 }}>Shown on Login, Home, Settings, and default notifications.</div>
      <div className="row" style={{ gap: 8 }}>
        <input className="input" value={appNameDraft} maxLength={40} onChange={e => setAppNameDraft(e.target.value)} placeholder="App name" />
        <Button variant="primary" size="sm" onClick={saveAppName} disabled={appNameDraft.trim() === (settings.appName || 'openGym')}>Save</Button>
      </div>
    </div>
    <h4 className="sec">Access policy</h4>
    <div className="card">
      <div className="row between"><div><div style={{ fontWeight: 600 }}>Invited users can edit plans and routines</div><div className="dim small">Global default; individual and group restrictions still apply.</div></div><button className={'btn xs ' + (settings.invitedPlanEditingEnabled ? 'primary' : 'danger')} onClick={toggleGlobal}>{settings.invitedPlanEditingEnabled ? 'Enabled' : 'Disabled'}</button></div>
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}><Button size="sm" icon="plus" onClick={createGroup}>New group</Button>{groups.map(g => <span key={g.id} className="row" style={{ gap: 4 }}><button className={'btn xs ' + (g.planEditingEnabled ? 'tinted' : 'danger')} onClick={() => updateGroup(g)}>{g.name}: {g.planEditingEnabled ? 'edit on' : 'edit off'}</button><button className="btn xs" onClick={() => manageMembers(g)}>Members ({(g.memberIds || []).length})</button></span>)}</div>
    </div>
    <h4 className="sec">Push notification</h4>
    <div className="card">
      <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" style={{ marginBottom: 8 }} />
      <textarea className="input" value={message} onChange={e => setMessage(e.target.value)} placeholder="Message" rows={3} style={{ marginBottom: 8, resize: 'vertical' }} />
      <div className="row" style={{ gap: 8, marginBottom: 8 }}><select className="input" value={recipient} onChange={e => { setRecipient(e.target.value); setSelected('') }}><option value="all">All users</option><option value="user">Individual user</option><option value="group">Group</option></select>{recipient === 'user' && <select className="input" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose user</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}{recipient === 'group' && <select className="input" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose group</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}</div>
      <Button variant="primary" icon="bell" disabled={!message.trim() || (recipient !== 'all' && !selected)} onClick={send}>Send notification</Button>
    </div>
  </>
}

/* ==================== Assign Plan Sheet (Admin -> User) ==================== */
function AssignPlanSheet({ user, onDone, close }) {
  const toast = useUI(s => s.toast)
  const adminState = useStore.getState().S
  const [adminPlans, setAdminPlans] = useState([])
  const [planChoice, setPlanChoice] = useState(() => adminState.plans?.[0]?.id || 'ppl')
  const [mode, setMode] = useState('replace') // 'replace' | 'merge'
  const [fileBundle, setFileBundle] = useState(null)
  const [loading, setLoading] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    api('/api/admin/plans').then(d => {
      const plans = d.plans || []
      setAdminPlans(plans)
      if (plans.length > 0) setPlanChoice(plans[0].id)
      else if (adminState.plans?.length > 0) setPlanChoice(adminState.plans[0].id)
    }).catch(() => {})
  }, [])

  const onFileChange = e => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const bundle = parsePlan(reader.result)
        setFileBundle(bundle)
        setPlanChoice('file')
        toast('Loaded plan file: ' + (bundle.name || `${bundle.routineCount} routines`))
      } catch (err) {
        toast(err.message || 'Failed to read plan file')
      }
    }
    reader.readAsText(file)
  }

  const assign = async () => {
    setLoading(true)
    let plan = null
    const template = adminPlans.find(p => p.id === planChoice)
    if (template) {
      plan = {
        name: template.name,
        routines: template.routines || [],
        week: template.week || {},
        customEx: template.customEx || []
      }
    } else {
      const myPlan = (adminState.plans || []).find(p => p.id === planChoice)
      if (myPlan) {
        plan = {
          name: myPlan.name,
          routines: myPlan.routines || [],
          week: myPlan.week || {},
          customEx: myPlan.customEx || []
        }
      } else if (planChoice === 'ppl') {
        const [push, pull, legs] = starterRoutines()
        plan = {
          name: 'Starter Plan (PPL)',
          routines: [push, pull, legs],
          week: { 1: push.id, 3: pull.id, 5: legs.id },
          customEx: []
        }
      } else if (planChoice === 'file' && fileBundle) {
        plan = {
          name: fileBundle.name || 'Imported Plan',
          routines: fileBundle.routines || [],
          week: fileBundle.week || {},
          customEx: fileBundle.customEx || []
        }
      }
    }

    if (!plan || !plan.routines?.length) {
      toast('Please select a plan with at least one routine')
      setLoading(false)
      return
    }

    try {
      await api('/api/admin/user/plan', {
        method: 'POST',
        body: JSON.stringify({ id: user.id, plan, mode })
      })
      toast(`Plan “${plan.name}” assigned to ${user.name}!`)
      onDone?.()
      close()
    } catch (e) {
      toast(e.message || 'Failed to assign plan')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h3 style={{ margin: '0 0 4px' }}>Assign Plan</h3>
      <div className="dim small" style={{ marginBottom: 12 }}>Setup or update routines for <strong style={{ color: 'var(--fg)' }}>{user.name}</strong></div>

      <div style={{ marginBottom: 14 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>Select Plan to Assign</div>
        <div className="list" style={{ gap: 6, maxHeight: '42vh', overflowY: 'auto' }}>
          {/* Admin Created Plan Templates */}
          {adminPlans.length > 0 && (
            <div className="small muted" style={{ fontWeight: 600, marginTop: 4, marginBottom: 2 }}>Plan Templates</div>
          )}
          {adminPlans.map(p => (
            <button
              key={p.id}
              type="button"
              className={'item' + (planChoice === p.id ? ' acc' : '')}
              style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === p.id ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
              onClick={() => setPlanChoice(p.id)}
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{p.name} <span className="tag acc" style={{ fontSize: '.68rem', marginLeft: 4 }}>Template</span></div>
                <div className="dim small">{p.routineCount || (p.routines || []).length} routines · {p.scheduledDays || Object.keys(p.week || {}).filter(k => p.week[k]).length} scheduled days{p.description ? ` · ${p.description}` : ''}</div>
              </div>
              {planChoice === p.id && <Icon name="check" style={{ color: 'var(--acc)' }} />}
            </button>
          ))}

          {/* Admin Profile's Plans */}
          {(adminState.plans || []).length > 0 && (
            <div className="small muted" style={{ fontWeight: 600, marginTop: 6, marginBottom: 2 }}>My Admin Plans</div>
          )}
          {(adminState.plans || []).map(p => (
            <button
              key={p.id}
              type="button"
              className={'item' + (planChoice === p.id ? ' acc' : '')}
              style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === p.id ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
              onClick={() => setPlanChoice(p.id)}
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{p.name} <span className="tag" style={{ fontSize: '.68rem', marginLeft: 4 }}>My Plan</span></div>
                <div className="dim small">{(p.routines || []).length} routines · {Object.keys(p.week || {}).filter(k => p.week[k]).length} scheduled days</div>
              </div>
              {planChoice === p.id && <Icon name="check" style={{ color: 'var(--acc)' }} />}
            </button>
          ))}

          {/* Presets & Files */}
          <div className="small muted" style={{ fontWeight: 600, marginTop: 6, marginBottom: 2 }}>Presets & Files</div>
          <button
            type="button"
            className={'item' + (planChoice === 'ppl' ? ' acc' : '')}
            style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === 'ppl' ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
            onClick={() => setPlanChoice('ppl')}
          >
            <div className="grow" style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: '.9rem' }}>Starter Plan (PPL)</div>
              <div className="dim small">Mon Push · Wed Pull · Fri Legs (3 routines)</div>
            </div>
            {planChoice === 'ppl' && <Icon name="check" style={{ color: 'var(--acc)' }} />}
          </button>

          <button
            type="button"
            className={'item' + (planChoice === 'file' ? ' acc' : '')}
            style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === 'file' ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
            onClick={() => fileRef.current?.click()}
          >
            <div className="grow" style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: '.9rem' }}>Upload Plan File (.json)</div>
              <div className="dim small">{fileBundle ? `Selected: ${fileBundle.name || fileBundle.routineCount + ' routines'}` : 'Select a saved openGym plan file'}</div>
            </div>
            {planChoice === 'file' && <Icon name="check" style={{ color: 'var(--acc)' }} />}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onFileChange} />
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>Assignment Mode</div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={'btn ' + (mode === 'replace' ? 'primary' : 'tinted')}
            style={{ flex: 1, fontSize: '.85rem' }}
            onClick={() => setMode('replace')}
          >
            Replace Plan
          </button>
          <button
            type="button"
            className={'btn ' + (mode === 'merge' ? 'primary' : 'tinted')}
            style={{ flex: 1, fontSize: '.85rem' }}
            onClick={() => setMode('merge')}
          >
            Merge Routines
          </button>
        </div>
        <div className="dim small" style={{ marginTop: 6, fontSize: '.75rem' }}>
          {mode === 'replace'
            ? "Replaces user's existing routines & week schedule."
            : "Appends the selected routines to user's existing routines."}
        </div>
      </div>

      <Button variant="primary" style={{ width: '100%' }} onClick={assign} disabled={loading}>
        {loading ? 'Assigning…' : 'Apply Plan to User'}
      </Button>
    </>
  )
}

/* ==================== User Drilldown Detail ==================== */
function UserDetail({ id, onChanged, close }) {
  const [d, setD] = useState(null)
  const currentUser = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)

  const reloadUser = () => {
    api('/api/admin/user?id=' + encodeURIComponent(id)).then(setD).catch(e => toast(e.message))
  }

  useEffect(() => { reloadUser() }, [id])
  if (!d) return <div className="muted small">Loading…</div>
  const u = d.user
  const setDisabled = disabled => {
    api('/api/admin/user/disable', { method: 'POST', body: JSON.stringify({ id: u.id, disabled }) })
      .then(() => { toast(disabled ? 'User disabled' : 'User enabled'); onChanged(); close() })
      .catch(e => toast(e.message))
  }
  const setPlanEditing = enabled => {
    api('/api/admin/user/permissions', { method: 'PUT', body: JSON.stringify({ id: u.id, planEditingOverride: enabled }) })
      .then(() => { toast(enabled ? 'Plan editing enabled' : 'Plan editing disabled'); reloadUser(); onChanged() })
      .catch(e => toast(e.message))
  }
  const setExpiry = () => {
    const value = window.prompt('Expiration date (YYYY-MM-DD), blank to clear', u.expiresAt ? u.expiresAt.slice(0, 10) : '')
    if (value === null) return
    api('/api/admin/user/expiry', { method: 'PUT', body: JSON.stringify({ id: u.id, expiresAt: value || null }) })
      .then(() => { toast(value ? 'Expiration updated' : 'Expiration cleared'); reloadUser(); onChanged() })
      .catch(e => toast(e.message))
  }
  const toggleRole = () => {
    if (u.admin && u.id === currentUser?.id) return toast('You cannot remove your own admin access')
    const makeAdmin = !u.admin
    const action = () => api('/api/admin/user/role', { method: 'PUT', body: JSON.stringify({ id: u.id, admin: makeAdmin }) })
      .then(() => { toast(makeAdmin ? 'User promoted to admin' : 'Admin removed'); reloadUser(); onChanged() })
      .catch(e => toast(e.message))
    if (makeAdmin) action()
    else confirmSheet({ title: 'Remove admin access?', message: `${u.name} will no longer see or use the admin dashboard.`, confirmText: 'Remove admin', danger: true, onConfirm: action })
  }

  const openAssignPlan = () => {
    openSheet(closeAssign => (
      <AssignPlanSheet
        user={u}
        onDone={() => { reloadUser(); onChanged() }}
        close={closeAssign}
      />
    ))
  }

  return <>
    <h3 className="capitalize">{u.name}</h3>
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0 12px' }}>
      {u.admin && <span className="tag acc">admin</span>}
      {u.disabled && <span className="tag" style={{ color: 'var(--red)' }}>disabled</span>}
      {u.invitedBy && <span className="tag">invite {u.invitedBy}</span>}
      <span className="tag">joined {u.created ? fmtDate(u.created.slice(0, 10)) : '—'}</span>
    </div>
    <div className="tiles" style={{ textAlign: 'left' }}>
      <div className="tile"><div className="l">Workouts</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.workouts.length}</div></div>
      <div className="tile"><div className="l">Weigh-ins</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.bodyweight.length}</div></div>
      <div className="tile"><div className="l">Routines</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.routines.length}</div></div>
      <div className="tile"><div className="l">Last sync</div><div className="v" style={{ fontSize: '.95rem' }}>{rel(d.lastSync)}</div></div>
    </div>

    <div className="row between" style={{ margin: '14px 0 6px', alignItems: 'center' }}>
      <h4 className="sec" style={{ margin: 0 }}>Plan & Routines</h4>
      <Button variant="tinted" size="sm" icon="sparkles" onClick={openAssignPlan}>{t('Assign Plan')}</Button>
    </div>

    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row between" style={{ marginBottom: 10 }}><div><div style={{ fontWeight: 600 }}>Account controls</div><div className="dim small">Manage access for this user.</div></div>{u.admin && <span className="tag acc">administrator</span>}</div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {!u.admin && <Button size="sm" variant={u.canEditPlans ? 'danger' : 'tinted'} onClick={() => setPlanEditing(!u.canEditPlans)}>{u.canEditPlans ? 'Disable plan editing' : 'Enable plan editing'}</Button>}
        <Button size="sm" variant="tinted" onClick={setExpiry}>{u.expiresAt ? 'Change expiry' : 'Set expiry'}</Button>
        <Button size="sm" variant={u.admin ? 'danger' : 'tinted'} disabled={u.admin && u.id === currentUser?.id} onClick={toggleRole}>{u.admin ? (u.id === currentUser?.id ? 'Current admin' : 'Remove admin') : 'Make admin'}</Button>
        {!u.admin && <Button size="sm" variant={u.disabled ? 'primary' : 'danger'} onClick={() => u.disabled ? setDisabled(false) : confirmSheet({ title: 'Disable ' + u.name + '?', message: 'They are signed out everywhere and can no longer sync or log in until re-enabled.', confirmText: 'Disable', danger: true, onConfirm: () => setDisabled(true) })}>{u.disabled ? 'Enable account' : 'Disable account'}</Button>}
      </div>
      <div className="dim small" style={{ marginTop: 8 }}>{u.canEditPlans ? 'Plan and routine editing is enabled.' : 'Plan and routine editing is disabled.'}{u.expiresAt ? ` Expires ${fmtDate(u.expiresAt.slice(0, 10))}.` : ' No expiration date set.'}</div>
    </div>

    {d.routines.length ? (
      <div className="list" style={{ gap: 4, marginBottom: 12 }}>
        {d.routines.map(r => (
          <div key={r.id} className="row between" style={{ padding: '6px 4px', borderBottom: '1px solid var(--sep)' }}>
            <span style={{ fontWeight: 500, fontSize: '.88rem' }}>{r.name}</span>
            <span className="small muted">{r.count} exercise{r.count !== 1 ? 's' : ''}</span>
          </div>
        ))}
      </div>
    ) : (
      <div className="empty small" style={{ marginBottom: 12 }}>No routines set up yet.</div>
    )}

    <h4 className="sec" style={{ marginTop: 14 }}>Workout history</h4>
    {d.workouts.length ? <div className="list" style={{ gap: 0 }}>
      {d.workouts.slice(0, 60).map(w => <div key={w.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <div><div className="small" style={{ fontWeight: 600 }}>{w.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{fmtDate(w.d, true)} · {fmtDur((w.end || w.start) - w.start)} · {setsDone(w)} sets{w.prs?.length ? ' · ' + w.prs.length + ' PR' : ''}</div></div>
        <span className="small muted">{fmtVol(w.vol ?? workoutVolume(w), d.unit)}</span>
      </div>)}
    </div> : <div className="empty small">No workouts logged.</div>}
  </>
}

/* ==================== Clone Routine Modal (Admin only) ==================== */
function CloneRoutineModal({ targetPlan, allPlans, onCloned, close }) {
  const toast = useUI(s => s.toast)
  const adminState = useStore.getState().S
  const [sourcePlanId, setSourcePlanId] = useState('active') // 'active' or template id
  const [selectedRoutineId, setSelectedRoutineId] = useState(null)
  const [loading, setLoading] = useState(false)

  // Get available routines from selected source
  const sourceRoutines = sourcePlanId === 'active'
    ? (adminState.routines || [])
    : ((allPlans.find(p => p.id === sourcePlanId) || {}).routines || [])

  const doClone = async () => {
    const routine = sourceRoutines.find(r => r.id === selectedRoutineId)
    if (!routine) { toast('Select a routine to clone'); return }

    setLoading(true)
    try {
      if (targetPlan.id) {
        // Saved server plan
        await api('/api/admin/plans/clone-routine', {
          method: 'POST',
          body: JSON.stringify({
            targetPlanId: targetPlan.id,
            routine
          })
        })
      }
      onCloned?.(routine)
      toast(`Cloned “${routine.name}” into plan!`)
      close()
    } catch (e) {
      toast(e.message || 'Failed to clone routine')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h3 style={{ margin: '0 0 6px' }}>Clone Routine into Plan</h3>
      <div className="dim small" style={{ marginBottom: 12 }}>Copy an existing routine with all exercises and settings into <strong>{targetPlan.name || 'this plan'}</strong>.</div>

      <div style={{ marginBottom: 12 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Source Plan</div>
        <select
          className="input"
          value={sourcePlanId}
          onChange={e => { setSourcePlanId(e.target.value); setSelectedRoutineId(null) }}
        >
          <option value="active">My Active Plan (Admin Profile)</option>
          {allPlans.filter(p => p.id !== targetPlan.id).map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>Select Routine to Clone</div>
        <div className="list" style={{ gap: 6, maxHeight: '35vh', overflowY: 'auto' }}>
          {sourceRoutines.map(r => (
            <button
              key={r.id}
              type="button"
              className={'item' + (selectedRoutineId === r.id ? ' acc' : '')}
              style={{ padding: '8px 12px', borderRadius: 8, cursor: 'pointer', border: selectedRoutineId === r.id ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
              onClick={() => setSelectedRoutineId(r.id)}
            >
              <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
              <div className="grow" style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{r.name}</div>
                <div className="dim small">{(r.ex || []).length} exercises</div>
              </div>
              {selectedRoutineId === r.id && <Icon name="check" style={{ color: 'var(--acc)' }} />}
            </button>
          ))}
          {!sourceRoutines.length && <div className="empty small">No routines available in this plan.</div>}
        </div>
      </div>

      <Button variant="primary" style={{ width: '100%' }} disabled={!selectedRoutineId || loading} onClick={doClone}>
        {loading ? 'Cloning…' : 'Clone Routine'}
      </Button>
    </>
  )
}

/* ==================== Edit / Create Plan Template Sheet ==================== */
function EditPlanTemplateSheet({ plan, allPlans, onSaved, close }) {
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)

  const isNew = !plan?.id
  const [name, setName] = useState(plan?.name || '')
  const [description, setDescription] = useState(plan?.description || '')
  const [routines, setRoutines] = useState(plan?.routines ? JSON.parse(JSON.stringify(plan.routines)) : [])
  const [week, setWeek] = useState(plan?.week ? { ...plan.week } : {})
  const [loading, setLoading] = useState(false)

  const addEmptyRoutine = () => {
    const nr = { id: uid(), name: `Routine ${routines.length + 1}`, emoji: DEFAULT_GLYPH, ex: [] }
    setRoutines([...routines, nr])
  }

  const removeRoutine = (rId) => {
    setRoutines(routines.filter(r => r.id !== rId))
    const nw = { ...week }
    Object.keys(nw).forEach(d => { if (nw[d] === rId) delete nw[d] })
    setWeek(nw)
  }

  const openCloneRoutine = () => {
    openSheet(closeClone => (
      <CloneRoutineModal
        targetPlan={{ id: plan?.id, name }}
        allPlans={allPlans}
        onCloned={routine => {
          const cloned = cloneRoutineObject(routine)
          setRoutines(prev => [...prev, cloned])
        }}
        close={closeClone}
      />
    ))
  }

  const save = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) { toast('Plan name is required'); return }

    setLoading(true)
    try {
      if (isNew) {
        await api('/api/admin/plans', {
          method: 'POST',
          body: JSON.stringify({ name: trimmedName, description, routines, week })
        })
        toast(`Plan template “${trimmedName}” created!`)
      } else {
        await api('/api/admin/plans', {
          method: 'PUT',
          body: JSON.stringify({ id: plan.id, name: trimmedName, description, routines, week })
        })
        toast(`Plan template “${trimmedName}” updated!`)
      }
      onSaved?.()
      close()
    } catch (e) {
      toast(e.message || 'Failed to save plan template')
    } finally {
      setLoading(false)
    }
  }

  const deletePlan = () => {
    if (isNew) { close(); return }
    confirmSheet({
      title: `Delete “${plan.name}”?`,
      message: 'This plan template will be permanently removed.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api('/api/admin/plans', { method: 'DELETE', body: JSON.stringify({ id: plan.id }) })
          toast('Plan template deleted')
          onSaved?.()
          close()
        } catch (e) {
          toast(e.message || 'Failed to delete')
        }
      }
    })
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{isNew ? 'Create Plan Template' : 'Edit Plan Template'}</h3>
        {!isNew && (
          <button className="iconbtn" style={{ color: 'var(--red)' }} onClick={deletePlan} aria-label="Delete Plan" title="Delete Plan">
            <Icon name="trash" />
          </button>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Plan Name</div>
        <input
          className="input"
          placeholder="e.g. Upper / Lower 4-Day"
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={60}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Description (optional)</div>
        <input
          className="input"
          placeholder="e.g. Recommended for beginners and intermediates"
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={150}
        />
      </div>

      {/* Routines in this template */}
      <div style={{ marginBottom: 14 }}>
        <div className="row between" style={{ alignItems: 'center', marginBottom: 6 }}>
          <div className="small muted" style={{ fontWeight: 600 }}>Routines in this plan ({routines.length})</div>
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" variant="tinted" icon="shuffle" onClick={openCloneRoutine} title="Clone routine from another plan">Clone Routine</Button>
            <Button size="sm" variant="primary" icon="plus" onClick={addEmptyRoutine}>Add Routine</Button>
          </div>
        </div>

        <div className="list" style={{ gap: 4, maxHeight: '25vh', overflowY: 'auto' }}>
          {routines.map((r, idx) => (
            <div key={r.id || idx} className="item" style={{ padding: '8px 10px' }}>
              <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
              <div className="grow">
                <input
                  className="input"
                  value={r.name}
                  onChange={e => {
                    const nr = [...routines]
                    nr[idx].name = e.target.value
                    setRoutines(nr)
                  }}
                  style={{ height: 30, fontSize: '.88rem', fontWeight: 600 }}
                />
                <div className="dim small" style={{ fontSize: '.72rem', marginTop: 2 }}>{(r.ex || []).length} exercises configured</div>
              </div>
              <button className="iconbtn" style={{ width: 28, height: 28, color: 'var(--red)' }} onClick={() => removeRoutine(r.id)}>
                <Icon name="trash" />
              </button>
            </div>
          ))}
          {!routines.length && <div className="empty small">No routines added yet. Click "+ Add Routine" or "Clone Routine".</div>}
        </div>
      </div>

      {/* Week Schedule */}
      <div style={{ marginBottom: 18 }}>
        <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Weekly Schedule</div>
        <div className="list" style={{ gap: 4 }}>
          {[1, 2, 3, 4, 5, 6, 0].map(d => (
            <div key={d} className="row between" style={{ padding: '6px 4px', borderBottom: '1px solid var(--sep)', alignItems: 'center' }}>
              <span style={{ width: 90, fontWeight: 500, fontSize: '.88rem' }}>{DAYN[d]}</span>
              <select
                className="input"
                style={{ flex: 1, height: 32, fontSize: '.85rem' }}
                value={week[d] || ''}
                onChange={e => {
                  const nw = { ...week }
                  if (e.target.value) nw[d] = e.target.value
                  else delete nw[d]
                  setWeek(nw)
                }}
              >
                <option value="">Rest Day</option>
                {routines.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <Button variant="primary" style={{ width: '100%' }} onClick={save} disabled={loading}>
        {loading ? 'Saving…' : (isNew ? 'Create Plan Template' : 'Save Changes')}
      </Button>
    </>
  )
}

/* ==================== Plan Templates Card (Admin Section) ==================== */
function PlanTemplatesCard({ allPlans, reload }) {
  const openSheet = useUI(s => s.openSheet)

  const openCreate = () => {
    openSheet(close => <EditPlanTemplateSheet allPlans={allPlans} onSaved={reload} close={close} />)
  }

  const openEdit = (plan) => {
    openSheet(close => <EditPlanTemplateSheet plan={plan} allPlans={allPlans} onSaved={reload} close={close} />)
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row between" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Plan Templates</h2>
        <Button variant="primary" size="sm" onClick={openCreate} icon="plus">New Template</Button>
      </div>
      <div className="small muted" style={{ margin: '6px 0 10px' }}>
        Reusable plan templates for invited and registered users
      </div>

      <div className="list" style={{ gap: 6 }}>
        {allPlans.map(p => (
          <div
            key={p.id}
            className="item"
            style={{ cursor: 'pointer', padding: '10px 12px', borderRadius: 10 }}
            onClick={() => openEdit(p)}
          >
            <div className="grow">
              <div style={{ fontWeight: 600, fontSize: '.95rem' }}>{p.name}</div>
              <div className="dim small">{p.routineCount} routines · {p.scheduledDays} scheduled days{p.description ? ` · ${p.description}` : ''}</div>
            </div>
            <Icon name="pencil" className="chev" />
          </div>
        ))}
        {!allPlans.length && <div className="dim small">No plan templates created yet. Click "+ New Template" to create one.</div>}
      </div>
    </div>
  )
}

/* ==================== Generate Invite Code Sheet ==================== */
function NewInviteSheet({ allPlans, reload, close }) {
  const toast = useUI(s => s.toast)
  const adminState = useStore.getState().S
  const [note, setNote] = useState('')
  const [planChoice, setPlanChoice] = useState('none') // 'none' | 'ppl' | 'file' | <plan_id>
  const [fileBundle, setFileBundle] = useState(null)
  const [loading, setLoading] = useState(false)
  const fileRef = useRef(null)

  const onFileChange = e => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const bundle = parsePlan(reader.result)
        setFileBundle(bundle)
        setPlanChoice('file')
        toast('Loaded plan file: ' + (bundle.name || `${bundle.routineCount} routines`))
      } catch (err) {
        toast(err.message || 'Failed to read plan file')
      }
    }
    reader.readAsText(file)
  }

  const generate = async () => {
    setLoading(true)
    let plan = null
    if (planChoice === 'none') {
      plan = null
    } else {
      const template = (allPlans || []).find(p => p.id === planChoice)
      if (template) {
        plan = {
          name: template.name,
          routines: template.routines || [],
          week: template.week || {},
          customEx: template.customEx || []
        }
      } else {
        const myPlan = (adminState.plans || []).find(p => p.id === planChoice)
        if (myPlan) {
          plan = {
            name: myPlan.name,
            routines: myPlan.routines || [],
            week: myPlan.week || {},
            customEx: myPlan.customEx || []
          }
        } else if (planChoice === 'ppl') {
          const [push, pull, legs] = starterRoutines()
          plan = {
            name: 'Starter Plan (PPL)',
            routines: [push, pull, legs],
            week: { 1: push.id, 3: pull.id, 5: legs.id },
            customEx: []
          }
        } else if (planChoice === 'file' && fileBundle) {
          plan = {
            name: fileBundle.name || 'Imported Plan',
            routines: fileBundle.routines || [],
            week: fileBundle.week || {},
            customEx: fileBundle.customEx || []
          }
        }
      }
    }

    try {
      const { invite } = await api('/api/admin/invites/new', {
        method: 'POST',
        body: JSON.stringify({ note: note.trim(), plan })
      })
      navigator.clipboard?.writeText(invite.code).catch(() => {})
      toast('Code ' + invite.code + ' created & copied!')
      reload()
      close()
    } catch (e) {
      toast(e.message || 'Failed to create code')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h3 style={{ margin: '0 0 12px' }}>Generate invite code</h3>
      
      <div style={{ marginBottom: 14 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Note / recipient (optional)</div>
        <input
          className="input"
          placeholder="e.g. For Alex"
          value={note}
          onChange={e => setNote(e.target.value)}
          maxLength={50}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>Initial plan for invited user</div>
        <div className="list" style={{ gap: 6, maxHeight: '40vh', overflowY: 'auto' }}>
          <button
            type="button"
            className={'item' + (planChoice === 'none' ? ' acc' : '')}
            style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === 'none' ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
            onClick={() => setPlanChoice('none')}
          >
            <div className="grow" style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: '.9rem' }}>No initial plan</div>
              <div className="dim small">User starts with an empty workout plan</div>
            </div>
            {planChoice === 'none' && <Icon name="check" style={{ color: 'var(--acc)' }} />}
          </button>

          {/* Admin Plan Templates */}
          {(allPlans || []).length > 0 && (
            <div className="small muted" style={{ fontWeight: 600, marginTop: 4, marginBottom: 2 }}>Plan Templates</div>
          )}
          {(allPlans || []).map(p => (
            <button
              key={p.id}
              type="button"
              className={'item' + (planChoice === p.id ? ' acc' : '')}
              style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === p.id ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
              onClick={() => setPlanChoice(p.id)}
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{p.name} <span className="tag acc" style={{ fontSize: '.68rem', marginLeft: 4 }}>Template</span></div>
                <div className="dim small">{p.routineCount || (p.routines || []).length} routines · {p.scheduledDays || Object.keys(p.week || {}).filter(k => p.week[k]).length} scheduled days{p.description ? ` · ${p.description}` : ''}</div>
              </div>
              {planChoice === p.id && <Icon name="check" style={{ color: 'var(--acc)' }} />}
            </button>
          ))}

          {/* Admin Profile's Plans */}
          {(adminState.plans || []).length > 0 && (
            <div className="small muted" style={{ fontWeight: 600, marginTop: 6, marginBottom: 2 }}>My Admin Plans</div>
          )}
          {(adminState.plans || []).map(p => (
            <button
              key={p.id}
              type="button"
              className={'item' + (planChoice === p.id ? ' acc' : '')}
              style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === p.id ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
              onClick={() => setPlanChoice(p.id)}
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{p.name} <span className="tag" style={{ fontSize: '.68rem', marginLeft: 4 }}>My Plan</span></div>
                <div className="dim small">{(p.routines || []).length} routines · {Object.keys(p.week || {}).filter(k => p.week[k]).length} scheduled days</div>
              </div>
              {planChoice === p.id && <Icon name="check" style={{ color: 'var(--acc)' }} />}
            </button>
          ))}

          {/* Presets & Files */}
          <div className="small muted" style={{ fontWeight: 600, marginTop: 6, marginBottom: 2 }}>Presets & Files</div>
          <button
            type="button"
            className={'item' + (planChoice === 'ppl' ? ' acc' : '')}
            style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === 'ppl' ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
            onClick={() => setPlanChoice('ppl')}
          >
            <div className="grow" style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: '.9rem' }}>Starter Plan (PPL)</div>
              <div className="dim small">Mon Push · Wed Pull · Fri Legs (3 routines)</div>
            </div>
            {planChoice === 'ppl' && <Icon name="check" style={{ color: 'var(--acc)' }} />}
          </button>

          <button
            type="button"
            className={'item' + (planChoice === 'file' ? ' acc' : '')}
            style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: planChoice === 'file' ? '1.5px solid var(--acc)' : '1px solid var(--sep)' }}
            onClick={() => fileRef.current?.click()}
          >
            <div className="grow" style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: '.9rem' }}>Upload Plan File (.json)</div>
              <div className="dim small">{fileBundle ? `Selected: ${fileBundle.name || fileBundle.routineCount + ' routines'}` : 'Select a saved openGym plan file'}</div>
            </div>
            {planChoice === 'file' && <Icon name="check" style={{ color: 'var(--acc)' }} />}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onFileChange} />
        </div>
      </div>

      <Button variant="primary" style={{ width: '100%', marginTop: 8 }} onClick={generate} disabled={loading}>
        {loading ? 'Generating…' : 'Generate & Copy Code'}
      </Button>
    </>
  )
}

/* ==================== Invites List Card ==================== */
function InvitesCard({ invites, allPlans, reload }) {
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)

  const openNewInvite = () => {
    openSheet(close => <NewInviteSheet allPlans={allPlans} reload={reload} close={close} />)
  }

  const revoke = code => api('/api/admin/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) })
    .then(() => { toast('Code revoked'); reload() }).catch(e => toast(e.message))
  const open = (invites || []).filter(i => !i.usedBy)
  const used = (invites || []).filter(i => i.usedBy)
  return <div className="card" style={{ marginBottom: 14 }}>
    <div className="row between"><h2 style={{ margin: 0 }}>Invite codes</h2>
      <Button variant="primary" size="sm" onClick={openNewInvite} icon="plus">Generate</Button></div>
    <div className="small muted" style={{ margin: '6px 0 10px' }}>{open.length} unused · {used.length} redeemed</div>
    {open.map(i => <div key={i.code} className="row between" style={{ padding: '7px 2px', borderBottom: '1px solid var(--sep)' }}>
      <div>
        <span style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontWeight: 500, letterSpacing: '.06em', cursor: 'pointer' }}
          onClick={() => { navigator.clipboard?.writeText(i.code).catch(() => {}); toast('Copied ' + i.code) }}>{i.code}</span>
        {i.note && <span className="small muted" style={{ marginLeft: 8 }}>({i.note})</span>}
        {i.planName && <span className="tag acc" style={{ marginLeft: 6, fontSize: '.68rem' }}>{i.planName}</span>}
      </div>
      <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }} onClick={() => revoke(i.code)} aria-label="revoke"><Icon name="trash" /></button>
    </div>)}
    {used.map(i => <div key={i.code} className="row between dim" style={{ padding: '7px 2px', fontSize: '.8rem' }}>
      <div>
        <span style={{ fontFamily: 'monospace' }}>{i.code}</span>
        {i.note && <span style={{ marginLeft: 6 }}>({i.note})</span>}
        {i.planName && <span className="tag" style={{ marginLeft: 6, fontSize: '.68rem' }}>{i.planName}</span>}
      </div>
      <span>→ {i.usedByName || 'used'}</span>
    </div>)}
    {!open.length && !used.length && <div className="dim small">No codes yet — generate one to invite someone.</div>}
  </div>
}

/* ==================== Main Admin Page ==================== */
export default function Admin() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const [users, setUsers] = useState(null)
  const [invites, setInvites] = useState(null)
  const [adminPlans, setAdminPlans] = useState([])
  const [inviteOnly, setInviteOnly] = useState(false)

  const loadUsers = () => api('/api/admin/users').then(d => { setUsers(d.users); setInviteOnly(d.invite_only) }).catch(e => toast(e.message || 'Failed to load'))
  const loadInvites = () => api('/api/admin/invites').then(d => setInvites(d.invites)).catch(() => {})
  const loadPlans = () => api('/api/admin/plans').then(d => setAdminPlans(d.plans || [])).catch(() => {})

  const loadAll = () => { loadUsers(); loadInvites(); loadPlans() }

  // poll every 15s so the "training now" section stays live without a manual refresh
  useEffect(() => {
    if (!user?.admin) return
    loadAll()
    const iv = setInterval(loadUsers, 15000)
    return () => clearInterval(iv)
  }, [])
  if (!user?.admin) return null

  const openUser = id => openSheet(close => <UserDetail id={id} onChanged={loadAll} close={close} />)
  const liveUsers = (users || []).filter(u => u.live)
  const activeCount = (users || []).filter(u => u.lastSync && Date.now() - u.lastSync < 7 * 86400000).length
  const disabledCount = (users || []).filter(u => u.disabled).length

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label="Back"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 8 }}><h1 style={{ margin: 0 }}>Admin</h1>
        <div className="sub">{users ? users.length + ' users · ' + activeCount + ' active this week' : 'Loading…'}</div></div>
      <button className="iconbtn" onClick={loadAll} aria-label="refresh">↻</button>
    </div>

    <div className="tiles" style={{ marginBottom: 12 }}>
      <div className="tile"><div className="l">Users</div><div className="v">{users ? users.length : '—'}</div></div>
      <div className="tile"><div className="l">Training now</div><div className="v" style={{ color: liveUsers.length ? 'var(--acc)' : undefined }}>{users ? liveUsers.length : '—'}</div></div>
      <div className="tile"><div className="l">Active 7d</div><div className="v">{users ? activeCount : '—'}</div></div>
      <div className="tile"><div className="l">Disabled</div><div className="v">{users ? disabledCount : '—'}</div></div>
    </div>

    <AdminControls users={users || []} reload={loadAll} />

    {liveUsers.length > 0 && <div className="card" style={{ borderColor: 'var(--acc)', marginBottom: 14 }}>
      <h2 className="row" style={{ margin: '0 0 8px', gap: 6 }}><Icon name="dot" style={{ fontSize: 10, color: 'var(--green)' }} />Training now</h2>
      {liveUsers.map(u => <div key={u.id} className="row between" style={{ padding: '8px 2px', borderBottom: '1px solid var(--sep)' }} onClick={() => openUser(u.id)}>
        <div><div className="small" style={{ fontWeight: 600 }}>{u.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{u.live.name} · ex {u.live.exIdx}/{u.live.exTotal} · {u.live.setsDone}/{u.live.setsTotal} sets</div></div>
        <span className="tag acc">{dur(Date.now() - u.live.startedAt)}</span>
      </div>)}
    </div>}

    {/* Plan Templates Library */}
    <PlanTemplatesCard allPlans={adminPlans} reload={loadPlans} />

    {/* Invites Card */}
    <InvitesCard invites={invites} allPlans={adminPlans} reload={loadInvites} />

    <h4 className="sec">Users</h4>
    <div className="list">
      {(users || []).map(u => <div key={u.id} className="item" onClick={() => openUser(u.id)} style={u.disabled ? { opacity: .55 } : null}>
        <div className="grow"><div className="tt">{u.live && <Icon name="dot" style={{ fontSize: 9, color: 'var(--green)', display: 'inline-block', marginRight: 5 }} />}{u.name} {u.admin && <span className="tag acc" style={{ marginLeft: 4 }}>admin</span>}{u.disabled && <span className="tag" style={{ marginLeft: 4, color: 'var(--red)' }}>off</span>}</div>
          <div className="ss">{u.live ? 'training now · ' + u.live.name : u.workouts + ' workouts' + (u.lastWorkout ? ' · last ' + fmtDate(u.lastWorkout) : '') + ' · synced ' + rel(u.lastSync)}</div></div>
        {u.hasPush && <Icon name="bell" title="push enabled" style={{ fontSize: 15, color: 'var(--label-3)' }} />}<Icon name="chevronRight" className="chev" />
      </div>)}
      {users && !users.length && <div className="empty">No users yet.</div>}
    </div>
  </div>
}
