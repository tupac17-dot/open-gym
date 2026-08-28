import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { DAYN, uid, exCount } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { dayAssignSheet, loadStarterPlan, planToolsSheet, confirmSheet } from '../sheets.jsx'
import {
  ensureUserPlans,
  switchActivePlan,
  clonePlanObject,
  addUserPlan,
  renameUserPlan,
  deleteUserPlan,
  getAllRoutinesAcrossPlans,
  addRoutinesToActivePlan
} from '../lib/plan-manager.js'
import { starterRoutines } from '../lib/starter.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { glyphOf, DEFAULT_GLYPH } from '../lib/glyphs.js'

function AssignPlanToUserSheet({ activePlan, close }) {
  const S = useStore(s => s.S)
  const toast = useUI(s => s.toast)
  const [users, setUsers] = useState([])
  const [selectedUserId, setSelectedUserId] = useState(null)
  const [mode, setMode] = useState('replace') // 'replace' | 'merge'
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)

  useEffect(() => {
    api('/api/admin/users')
      .then(d => {
        const uList = d.users || []
        setUsers(uList)
        if (uList.length > 0) setSelectedUserId(uList[0].id)
      })
      .catch(e => toast(e.message || t('Failed to load users')))
      .finally(() => setFetching(false))
  }, [])

  const filteredUsers = users.filter(u => {
    const q = query.toLowerCase().trim()
    if (!q) return true
    return u.name && u.name.toLowerCase().includes(q)
  })

  const selectedUser = users.find(u => u.id === selectedUserId)

  const handleAssign = async () => {
    if (!selectedUserId) {
      toast(t('Please select a user'))
      return
    }
    const routinesCount = (S.routines || []).length
    if (!routinesCount) {
      toast(t('Active plan has no routines to assign'))
      return
    }

    setLoading(true)
    try {
      const planData = {
        name: activePlan.name || t('Plan'),
        routines: S.routines || [],
        week: S.week || {},
        customEx: S.customEx || []
      }
      await api('/api/admin/user/plan', {
        method: 'POST',
        body: JSON.stringify({ id: selectedUserId, plan: planData, mode })
      })
      toast(t('Plan “{0}” successfully assigned to {1}!', activePlan.name, selectedUser?.name || t('User')))
      close()
    } catch (e) {
      toast(e.message || t('Failed to assign plan'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h3 style={{ margin: '0 0 4px' }}>{t('Assign Plan to User')}</h3>
      <div className="dim small" style={{ marginBottom: 12 }}>
        {t('Push the current plan')} <strong>“{activePlan?.name || t('Plan')}”</strong> ({exCount(S.routines?.length || 0)}) {t('to any user.')}
      </div>

      <input
        className="input"
        placeholder={t('Search users…')}
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{ marginBottom: 10 }}
      />

      <div style={{ marginBottom: 14 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>{t('Select Target User')}</div>
        <div className="list" style={{ gap: 6, maxHeight: '35vh', overflowY: 'auto' }}>
          {filteredUsers.map(u => {
            const isSelected = selectedUserId === u.id
            return (
              <button
                key={u.id}
                type="button"
                className={'item' + (isSelected ? ' acc' : '')}
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  border: isSelected ? '1.5px solid var(--acc)' : '1px solid var(--sep)'
                }}
                onClick={() => setSelectedUserId(u.id)}
              >
                <div className="grow" style={{ textAlign: 'left' }}>
                  <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: '.92rem' }}>{u.name}</span>
                    {u.admin && <span className="tag acc" style={{ fontSize: '.68rem' }}>admin</span>}
                    {u.disabled && <span className="tag" style={{ fontSize: '.68rem', color: 'var(--red)' }}>disabled</span>}
                  </div>
                  <div className="dim small" style={{ fontSize: '.75rem', marginTop: 2 }}>
                    {u.workouts || 0} {t('workouts logged')}
                  </div>
                </div>
                {isSelected && <Icon name="check" style={{ color: 'var(--acc)' }} />}
              </button>
            )
          })}
          {!filteredUsers.length && (
            <div className="empty small">
              {fetching ? t('Loading users…') : t('No users found.')}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>{t('Assignment Mode')}</div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={'btn ' + (mode === 'replace' ? 'primary' : 'tinted')}
            style={{ flex: 1, fontSize: '.85rem' }}
            onClick={() => setMode('replace')}
          >
            {t('Replace Plan')}
          </button>
          <button
            type="button"
            className={'btn ' + (mode === 'merge' ? 'primary' : 'tinted')}
            style={{ flex: 1, fontSize: '.85rem' }}
            onClick={() => setMode('merge')}
          >
            {t('Merge Routines')}
          </button>
        </div>
        <div className="dim small" style={{ marginTop: 6, fontSize: '.75rem' }}>
          {mode === 'replace'
            ? t("Replaces user's existing routines & week schedule with this plan.")
            : t("Appends this plan's routines to user's existing routines.")}
        </div>
      </div>

      <Button
        variant="primary"
        style={{ width: '100%' }}
        disabled={!selectedUserId || loading || !S.routines?.length}
        onClick={handleAssign}
      >
        {loading
          ? t('Assigning…')
          : selectedUser
            ? t('Assign “{0}” to {1}', activePlan?.name || t('Plan'), selectedUser.name)
            : t('Select a User')}
      </Button>
    </>
  )
}

function AllRoutinesSheet({ activePlan, close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)

  const allRoutines = getAllRoutinesAcrossPlans(S)
  const [selectedIds, setSelectedIds] = useState([])
  const [query, setQuery] = useState('')

  const filtered = allRoutines.filter(r => {
    const q = query.toLowerCase().trim()
    if (!q) return true
    return (
      (r.name && r.name.toLowerCase().includes(q)) ||
      (r.originPlan && r.originPlan.toLowerCase().includes(q))
    )
  })

  const toggleSelect = id => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const toggleAll = () => {
    if (selectedIds.length === filtered.length) {
      setSelectedIds([])
    } else {
      setSelectedIds(filtered.map(r => r.id))
    }
  }

  const handleConfirm = () => {
    const toAdd = allRoutines.filter(r => selectedIds.includes(r.id))
    if (!toAdd.length) return
    update(s => {
      addRoutinesToActivePlan(s, toAdd)
    })
    toast(t('Added {0} routine(s) to “{1}”', toAdd.length, activePlan?.name || t('Plan')))
    close()
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{t('All Stored Routines')}</h3>
        <span className="small muted">{allRoutines.length} {t('total')}</span>
      </div>
      <div className="dim small" style={{ marginBottom: 12 }}>
        {t('Select routines created across any plan to add them into')} <strong>{activePlan?.name || t('Active Plan')}</strong>.
      </div>

      <input
        className="input"
        placeholder={t('Search routines or origin plans…')}
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{ marginBottom: 10 }}
      />

      <div className="row between" style={{ alignItems: 'center', marginBottom: 10 }}>
        <span className="small muted">
          {selectedIds.length} {t('selected')}
        </span>
        {filtered.length > 0 && (
          <button
            type="button"
            className="btn plain small"
            style={{ padding: '2px 8px', fontSize: '.8rem', color: 'var(--acc)' }}
            onClick={toggleAll}
          >
            {selectedIds.length === filtered.length ? t('Deselect All') : t('Select All')}
          </button>
        )}
      </div>

      <div className="list" style={{ gap: 6, maxHeight: '42vh', overflowY: 'auto', marginBottom: 16 }}>
        {filtered.map(r => {
          const isSelected = selectedIds.includes(r.id)
          const inActive = (S.routines || []).some(ar => ar.name === r.name && ar.originPlan === r.originPlan)

          return (
            <div
              key={r.id}
              className={'item' + (isSelected ? ' acc' : '')}
              style={{
                cursor: 'pointer',
                borderRadius: 10,
                border: isSelected ? '1.5px solid var(--acc)' : '1px solid var(--sep)',
                padding: '9px 12px'
              }}
              onClick={() => toggleSelect(r.id)}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  border: isSelected ? '2px solid var(--acc)' : '1.5px solid var(--sep)',
                  background: isSelected ? 'var(--acc)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 8,
                  flex: 'none'
                }}
              >
                {isSelected && <Icon name="check" style={{ fontSize: 13, color: '#000' }} />}
              </div>

              <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>

              <div className="grow" style={{ textAlign: 'left' }}>
                <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: '.92rem' }}>{r.name}</span>
                  {inActive && <span className="tag" style={{ fontSize: '.68rem' }}>{t('In Plan')}</span>}
                </div>
                <div className="dim small" style={{ fontSize: '.75rem', marginTop: 2 }}>
                  <span style={{ color: 'var(--acc)' }}>📍 {r.originPlan || t('My Plan')}</span> · {exCount((r.ex || []).length)}
                </div>
              </div>
            </div>
          )
        })}

        {!filtered.length && (
          <div className="empty small">
            {query ? t('No routines match your search.') : t('No routines found.')}
          </div>
        )}
      </div>

      <Button
        variant="primary"
        style={{ width: '100%' }}
        disabled={selectedIds.length === 0}
        onClick={handleConfirm}
      >
        {selectedIds.length > 0
          ? t('Add ({0}) to “{1}”', selectedIds.length, activePlan?.name || t('Plan'))
          : t('Select Routines to Add')}
      </Button>
    </>
  )
}

function PlanManagerSheet({ close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)

  const [creating, setCreating] = useState(false)
  const [newPlanName, setNewPlanName] = useState('')
  const [newPlanType, setNewPlanType] = useState('empty') // 'empty' | 'ppl'

  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')

  const plans = S.plans || []
  const activeId = S.activePlanId

  const handleSelect = planId => {
    if (planId === activeId) { close(); return }
    update(s => switchActivePlan(s, planId))
    const p = plans.find(x => x.id === planId)
    toast(t('Switched to “{0}”', p?.name || t('Plan')))
    close()
  }

  const handleClone = (e, plan) => {
    e.stopPropagation()
    const cloned = clonePlanObject(plan)
    update(s => {
      s.plans.push(cloned)
      switchActivePlan(s, cloned.id)
    })
    toast(t('Cloned “{0}”', plan.name))
    close()
  }

  const handleDelete = (e, plan) => {
    e.stopPropagation()
    if (plans.length <= 1) {
      toast(t('Cannot delete your only plan'))
      return
    }
    confirmSheet({
      title: t('Delete plan?'),
      message: t('“{0}” and its routines will be permanently removed.', plan.name),
      confirmText: t('Delete'),
      danger: true,
      onConfirm: () => {
        update(s => deleteUserPlan(s, plan.id))
        toast(t('Plan deleted'))
      }
    })
  }

  const submitCreate = () => {
    const name = newPlanName.trim() || t('New Plan')
    let routines = []
    let week = {}
    if (newPlanType === 'ppl') {
      const [push, pull, legs] = starterRoutines()
      routines = [push, pull, legs].map(r => ({ ...r, originPlan: name }))
      week = { 1: push.id, 3: pull.id, 5: legs.id }
    }
    update(s => addUserPlan(s, name, routines, week))
    toast(t('Created “{0}”', name))
    close()
  }

  const startRename = (e, plan) => {
    e.stopPropagation()
    setRenamingId(plan.id)
    setRenameValue(plan.name)
  }

  const submitRename = (e, planId) => {
    e.stopPropagation()
    const val = renameValue.trim()
    if (val) {
      update(s => renameUserPlan(s, planId, val))
      toast(t('Renamed plan'))
    }
    setRenamingId(null)
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t('My Plans')}</h3>
        {!creating && (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {t('New Plan')}
          </Button>
        )}
      </div>

      {creating ? (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--acc)' }}>
          <h4 style={{ margin: '0 0 8px' }}>{t('Create New Plan')}</h4>
          <input
            className="input"
            placeholder={t('Plan name (e.g. Upper / Lower)')}
            value={newPlanName}
            onChange={e => setNewPlanName(e.target.value)}
            style={{ marginBottom: 10 }}
            autoFocus
          />
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              className={'btn ' + (newPlanType === 'empty' ? 'primary' : 'tinted')}
              style={{ flex: 1, fontSize: '.85rem' }}
              onClick={() => setNewPlanType('empty')}
            >
              {t('Empty Plan')}
            </button>
            <button
              type="button"
              className={'btn ' + (newPlanType === 'ppl' ? 'primary' : 'tinted')}
              style={{ flex: 1, fontSize: '.85rem' }}
              onClick={() => setNewPlanType('ppl')}
            >
              {t('Starter PPL')}
            </button>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button variant="plain" style={{ flex: 1 }} onClick={() => setCreating(false)}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" style={{ flex: 1 }} onClick={submitCreate}>
              {t('Create')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="list" style={{ gap: 6 }}>
        {plans.map(p => {
          const isActive = p.id === activeId
          const rCount = (p.routines || []).length
          const sDays = Object.keys(p.week || {}).filter(k => p.week[k]).length
          const isRenaming = renamingId === p.id

          return (
            <div
              key={p.id}
              className={'item' + (isActive ? ' acc' : '')}
              style={{
                cursor: 'pointer',
                borderRadius: 12,
                border: isActive ? '1.5px solid var(--acc)' : '1px solid var(--sep)',
                padding: '10px 12px'
              }}
              onClick={() => handleSelect(p.id)}
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                {isRenaming ? (
                  <div className="row" style={{ gap: 6 }} onClick={e => e.stopPropagation()}>
                    <input
                      className="input"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      style={{ height: 32, fontSize: '.9rem' }}
                      autoFocus
                    />
                    <Button size="sm" variant="primary" onClick={e => submitRename(e, p.id)}>
                      <Icon name="check" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: '.95rem' }}>{p.name}</span>
                      {isActive && <span className="tag acc" style={{ fontSize: '.7rem' }}>{t('Active')}</span>}
                    </div>
                    <div className="dim small" style={{ fontSize: '.75rem', marginTop: 2 }}>
                      {t('{0} routines · {1} scheduled days', rCount, sDays)}
                    </div>
                  </>
                )}
              </div>

              <div className="row" style={{ gap: 4, flex: 'none' }} onClick={e => e.stopPropagation()}>
                <button
                  className="iconbtn"
                  style={{ width: 30, height: 30, borderRadius: 7, fontSize: 13 }}
                  title={t('Clone plan')}
                  aria-label={t('Clone plan')}
                  onClick={e => handleClone(e, p)}
                >
                  <Icon name="shuffle" />
                </button>
                <button
                  className="iconbtn"
                  style={{ width: 30, height: 30, borderRadius: 7, fontSize: 13 }}
                  title={t('Rename plan')}
                  aria-label={t('Rename plan')}
                  onClick={e => startRename(e, p)}
                >
                  <Icon name="pencil" />
                </button>
                {plans.length > 1 && (
                  <button
                    className="iconbtn"
                    style={{ width: 30, height: 30, borderRadius: 7, fontSize: 13, color: 'var(--red)' }}
                    title={t('Delete plan')}
                    aria-label={t('Delete plan')}
                    onClick={e => handleDelete(e, p)}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

export default function Plan() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const update = useStore(s => s.update)
  const openSheet = useUI(s => s.openSheet)

  ensureUserPlans(S)
  const activePlan = (S.plans || []).find(p => p.id === S.activePlanId) || S.plans?.[0]

  const openPlanManager = () => {
    openSheet(close => <PlanManagerSheet close={close} />)
  }

  const openAllRoutines = () => {
    openSheet(close => <AllRoutinesSheet activePlan={activePlan} close={close} />)
  }

  const openAssignToUser = () => {
    openSheet(close => <AssignPlanToUserSheet activePlan={activePlan} close={close} />)
  }

  const addRoutine = () => {
    const r = {
      id: uid(),
      name: t('New routine'),
      emoji: DEFAULT_GLYPH,
      ex: [],
      originPlan: activePlan?.name || t('My Plan')
    }
    update(s => { s.routines.push(r) })
    nav('/plan/r/' + r.id)
  }

  return <>
    <div className="hdr">
      <div>
        <div
          className="row"
          style={{ alignItems: 'center', gap: 6, cursor: 'pointer' }}
          onClick={openPlanManager}
          title={t('Switch or manage plans')}
        >
          <h1 style={{ margin: 0 }}>{activePlan?.name || t('Plan')}</h1>
          <Icon name="chevronDown" style={{ fontSize: 18, color: 'var(--acc)' }} />
        </div>
        <div className="sub">
          {t('{0} routines · {1} scheduled days', S.routines.length, Object.keys(S.week || {}).filter(k => S.week[k]).length)}
        </div>
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        {user?.admin && (
          <Button size="sm" variant="tinted" icon="sparkles" onClick={openAssignToUser} title={t('Assign this plan to any user')}>
            {t('+ Assign To User')}
          </Button>
        )}
        <button className="iconbtn" onClick={openPlanManager} aria-label={t('Manage plans')} title={t('Manage plans')}>
          <Icon name="list" />
        </button>
        <button className="iconbtn" onClick={planToolsSheet} aria-label={t('Share your plan')} title={t('Share your plan')}>
          <Icon name="upload" />
        </button>
      </div>
    </div>

    <div className="cols"><div>
      <h4 className="sec">{t('Week schedule')}</h4>
      <div className="list" style={{ display: 'flex', flexDirection: 'column' }}>
        {[1, 2, 3, 4, 5, 6, 0].map(d => {
          const r = S.routines.find(x => x.id === S.week[d])
          return <div key={d} className="item" onClick={() => dayAssignSheet(d)}>
            <div className="grow"><div className="tt">{t(DAYN[d])}</div></div>
            {r ? <span className="tag acc"><Icon name={glyphOf(r.emoji)} />{r.name}</span> : <span className="tag">{t('Rest')}</span>}
            <Icon name="chevronRight" className="chev" /></div>
        })}
      </div>
    </div><div>
      <div className="row between" style={{ marginTop: 22, marginBottom: 10, alignItems: 'center' }}>
        <h4 className="sec" style={{ margin: 0 }}>{t('Routines')}</h4>
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="tinted" icon="list" onClick={openAllRoutines} title={t('All stored routines')}>
            {t('All Routines')}
          </Button>
          <Button size="sm" variant="primary" icon="plus" onClick={addRoutine}>
            {t('New')}
          </Button>
        </div>
      </div>
      {S.routines.length ? <div className="list">{S.routines.map(r => <div key={r.id} className="item" onClick={() => nav('/plan/r/' + r.id)}>
        <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
        <div className="grow">
          <div className="tt">{r.name}</div>
          <div className="ss">
            {exCount(r.ex.length)}
            {r.originPlan && r.originPlan !== activePlan?.name ? ` · 📍 ${r.originPlan}` : ''}
          </div>
        </div>
        <Icon name="chevronRight" className="chev" /></div>)}</div> : <>
        <div className="empty"><div className="ico"><Icon name="clipboard" /></div>{t('No routines yet in this plan.')}<br />{t('Create one, load starter plan, or pick from All Routines.')}</div>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <Button style={{ flex: 1 }} variant="tinted" icon="list" onClick={openAllRoutines}>{t('All Routines')}</Button>
          <Button style={{ flex: 1 }} icon="sparkles" onClick={loadStarterPlan}>{t('Starter PPL')}</Button>
        </div>
      </>}
    </div></div>
  </>
}
