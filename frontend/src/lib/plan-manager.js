// Multi-Plan Management Utilities
import { uid } from './format.js'
import { t } from './i18n.js'

/** Ensure a user state has a valid plans array, activePlanId, and allRoutines library */
export function ensureUserPlans(S) {
  if (!S) return
  if (!Array.isArray(S.allRoutines)) {
    S.allRoutines = []
  }

  if (!Array.isArray(S.plans) || S.plans.length === 0) {
    const defaultPlanId = 'plan_' + uid()
    const defaultPlanName = t('My Plan')
    const initialRoutines = (Array.isArray(S.routines) ? S.routines : []).map(r => ({
      ...r,
      originPlan: r.originPlan || defaultPlanName
    }))
    const defaultPlan = {
      id: defaultPlanId,
      name: defaultPlanName,
      routines: initialRoutines,
      week: (typeof S.week === 'object' && S.week) ? S.week : {},
      customEx: Array.isArray(S.customEx) ? S.customEx : []
    }
    S.plans = [defaultPlan]
    S.activePlanId = defaultPlanId
  }

  if (!S.activePlanId || !S.plans.some(p => p.id === S.activePlanId)) {
    S.activePlanId = S.plans[0].id
  }
}

/** Sync the current S.routines and S.week into the active plan and global allRoutines */
export function syncActivePlan(S) {
  if (!S || !Array.isArray(S.plans) || !S.activePlanId) return
  const activePlan = S.plans.find(p => p.id === S.activePlanId)
  if (activePlan) {
    // Stamp active plan name if missing on any routine
    const stampedRoutines = (S.routines || []).map(r => ({
      ...r,
      originPlan: r.originPlan || activePlan.name || t('My Plan')
    }))
    S.routines = stampedRoutines
    activePlan.routines = stampedRoutines
    activePlan.week = S.week || {}
    activePlan.customEx = S.customEx || []
  }

  // Also maintain global allRoutines library
  if (!Array.isArray(S.allRoutines)) S.allRoutines = []
  
  // Register active plan routines in allRoutines if not present
  ;(S.routines || []).forEach(r => {
    const idx = S.allRoutines.findIndex(ar => ar.id === r.id)
    const item = {
      ...r,
      originPlan: r.originPlan || activePlan?.name || t('My Plan'),
      updatedAt: Date.now()
    }
    if (idx >= 0) {
      S.allRoutines[idx] = item
    } else {
      S.allRoutines.push(item)
    }
  })
}

/** Switch the currently active plan */
export function switchActivePlan(S, newPlanId) {
  ensureUserPlans(S)
  syncActivePlan(S)
  const nextPlan = S.plans.find(p => p.id === newPlanId)
  if (!nextPlan) return false
  S.activePlanId = newPlanId
  S.routines = nextPlan.routines || []
  S.week = nextPlan.week || {}
  return true
}

/** Deep clone a plan with completely new routine IDs and mapped week schedule */
export function clonePlanObject(plan, newName) {
  const ridMap = {}
  const targetName = newName || (plan.name ? `${plan.name} (Copy)` : t('Cloned Plan'))
  
  const routines = (plan.routines || []).map(r => {
    const nid = uid()
    ridMap[r.id] = nid
    return {
      ...JSON.parse(JSON.stringify(r)),
      id: nid,
      originPlan: r.originPlan || plan.name || targetName
    }
  })

  const week = {}
  Object.entries(plan.week || {}).forEach(([d, oldRid]) => {
    if (ridMap[oldRid]) week[d] = ridMap[oldRid]
  })

  return {
    id: 'plan_' + uid(),
    name: targetName,
    description: plan.description || '',
    routines,
    week,
    customEx: JSON.parse(JSON.stringify(plan.customEx || []))
  }
}

/** Clone a single routine with a fresh unique ID */
export function cloneRoutineObject(routine, newName) {
  return {
    ...JSON.parse(JSON.stringify(routine)),
    id: uid(),
    name: newName || routine.name || t('Cloned Routine'),
    originPlan: routine.originPlan || t('Custom Plan')
  }
}

/** Add a new plan to user state and make it active */
export function addUserPlan(S, name, routines = [], week = {}) {
  ensureUserPlans(S)
  syncActivePlan(S)
  const planName = name || t('New Plan')
  const stampedRoutines = (routines || []).map(r => ({
    ...r,
    originPlan: r.originPlan || planName
  }))
  const newPlan = {
    id: 'plan_' + uid(),
    name: planName,
    routines: stampedRoutines,
    week,
    customEx: []
  }
  S.plans.push(newPlan)
  S.activePlanId = newPlan.id
  S.routines = newPlan.routines
  S.week = newPlan.week
  syncActivePlan(S)
  return newPlan
}

/** Rename a plan in user state */
export function renameUserPlan(S, planId, newName) {
  ensureUserPlans(S)
  const p = S.plans.find(x => x.id === planId)
  if (p) {
    p.name = newName.trim() || t('Plan')
    // Update originPlan for routines that belonged to this plan
    p.routines = (p.routines || []).map(r => ({
      ...r,
      originPlan: r.originPlan === p.name ? p.name : (r.originPlan || p.name)
    }))
    if (S.activePlanId === planId) {
      S.routines = p.routines
    }
  }
}

/** Delete a plan from user state */
export function deleteUserPlan(S, planId) {
  ensureUserPlans(S)
  if (S.plans.length <= 1) return false
  S.plans = S.plans.filter(p => p.id !== planId)
  if (S.activePlanId === planId) {
    S.activePlanId = S.plans[0].id
    S.routines = S.plans[0].routines || []
    S.week = S.plans[0].week || {}
  }
  return true
}

/** Get all unique routines across all plans and global routines list */
export function getAllRoutinesAcrossPlans(S) {
  ensureUserPlans(S)
  const seenIds = new Set()
  const list = []

  // 1. Gather from all plans
  ;(S.plans || []).forEach(p => {
    (p.routines || []).forEach(r => {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id)
        list.push({
          ...r,
          originPlan: r.originPlan || p.name || t('My Plan'),
          planId: p.id,
          planName: p.name
        })
      }
    })
  })

  // 2. Gather from active S.routines
  ;(S.routines || []).forEach(r => {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id)
      list.push({
        ...r,
        originPlan: r.originPlan || t('Active Plan'),
        planId: S.activePlanId,
        planName: t('Active Plan')
      })
    }
  })

  // 3. Gather from global S.allRoutines
  ;(S.allRoutines || []).forEach(r => {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id)
      list.push({
        ...r,
        originPlan: r.originPlan || t('Saved Routines')
      })
    }
  })

  return list
}

/** Add/clone selected routines into active plan */
export function addRoutinesToActivePlan(S, routinesToClone) {
  ensureUserPlans(S)
  const activePlan = S.plans.find(p => p.id === S.activePlanId) || S.plans[0]
  if (!activePlan) return []

  const cloned = routinesToClone.map(r => ({
    ...JSON.parse(JSON.stringify(r)),
    id: uid(),
    originPlan: r.originPlan || r.planName || activePlan.name
  }))

  if (!Array.isArray(S.routines)) S.routines = []
  S.routines.push(...cloned)
  syncActivePlan(S)
  return cloned
}
