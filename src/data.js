import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  getDoc,
  orderBy
} from "firebase/firestore";

const COLLECTION = "phases";
const CLIENTS_COLLECTION = "clients";
const ROLES_COLLECTION = "userRoles";
const LOGS_COLLECTION = "audit_logs";
const USERS_COLLECTION = "userRoles"; // same collection, users are identified by uid

/**
 * Parse a date string in DD/MM/YYYY or YYYY-MM-DD format
 */
export function parseDate(str) {
  if (!str) return null;
  if (str.includes("-")) {
    const [y, m, d] = str.split("-");
    if (!y || !m || !d) return null;
    return new Date(+y, +m - 1, +d);
  }
  const [d, m, y] = str.split("/");
  if (!d || !m || !y) return null;
  return new Date(+y, +m - 1, +d);
}

/**
 * Calculates automatic progress based on elapsed time vs total timeframe (0 to 100%)
 */
export function calculateTimeProgress(startDateStr, deliveryDateStr) {
  const start = parseDate(startDateStr);
  const end = parseDate(deliveryDateStr);
  if (!start || !end || end <= start) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (today < start) return 0;
  if (today >= end) return 100;

  const totalTime = end.getTime() - start.getTime();
  const elapsedTime = today.getTime() - start.getTime();
  return Math.min(100, Math.max(0, Math.round((elapsedTime / totalTime) * 100)));
}

/**
 * Subscribes to real-time Firestore updates.
 * Calls `callback` with the aggregated projects array when data changes.
 */
export function subscribeToPhases(db, callback) {
  const colRef = collection(db, COLLECTION);
  return onSnapshot(colRef, (snapshot) => {
    const phases = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(phases);
  });
}

export function subscribeToClients(db, callback) {
  const colRef = collection(db, CLIENTS_COLLECTION);
  return onSnapshot(colRef, (snapshot) => {
    const clients = snapshot.docs.map(d => d.data());
    clients.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    callback(clients);
  });
}

export async function addClient(db, name) {
  const id = name.toLowerCase().replace(/[^a-z0-9]/gi, '-');
  const clientRef = doc(db, CLIENTS_COLLECTION, id);
  await setDoc(clientRef, { name, id, createdAt: Date.now() });
}

export function subscribeToLogs(db, callback) {
  const colRef = collection(db, LOGS_COLLECTION);
  const q = query(colRef, orderBy("timestamp", "desc"));
  return onSnapshot(q, (snapshot) => {
    const logs = snapshot.docs.map(d => d.data());
    callback(logs);
  });
}

/**
 * Updates a single project or phase document in Firestore.
 */
export async function updatePhase(db, phaseId, updates) {
  const phaseRef = doc(db, COLLECTION, phaseId);
  await updateDoc(phaseRef, { ...updates, lastModified: Date.now() });
}

/**
 * Creates a new project in Firestore (Single-Cycle Architecture).
 */
export async function createNewProject(db, projectName, clientName = 'General', responsible = '', startDate = '', deliveryDate = '') {
  const timestamp = Date.now();
  const projectId = `proj-${timestamp}`;
  const id = `${projectName}-${timestamp}`.replace(/[^a-z0-9]/gi, '-').toLowerCase();

  const projectData = {
    id,
    projectId,
    project: projectName,
    name: projectName,
    client: clientName,
    phase: 'Ciclo Principal',
    responsible: responsible || '',
    startDate: startDate || '',
    deliveryDate: deliveryDate || '',
    originalDeliveryDate: deliveryDate || '',
    endDate: deliveryDate || '',
    state: 'En curso',
    progress: 0,
    realProgress: 0,
    comment: '',
    inferredPhase: 'Levantamiento',
    isSingleCycle: true,
    isArchived: false,
    lastModified: timestamp
  };

  await setDoc(doc(db, COLLECTION, id), projectData);
}

/**
 * Postpones the project delivery date while permanently preserving the originalDeliveryDate.
 */
export async function postponeProjectDelivery(db, projectId, newDeliveryDate, reason = '') {
  if (!newDeliveryDate) return;
  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const docsToUpdate = snapshot.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.projectId === projectId || (p.project === projectId && !p.projectId) || p.id === projectId);

  if (docsToUpdate.length === 0) return;

  const firstDoc = docsToUpdate[0];
  const currentDelivery = firstDoc.deliveryDate || firstDoc.endDate || '';
  const originalDelivery = firstDoc.originalDeliveryDate || currentDelivery;

  const today = new Date();
  const d = String(today.getDate()).padStart(2, '0');
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const y = today.getFullYear();
  const dateStr = `${d}/${m}/${y}`;

  const reasonStr = reason && reason.trim() ? ` (Motivo: ${reason.trim()})` : '';
  const logEntry = `${dateStr}: ⏳ Fecha de entrega aplazada de ${currentDelivery} a ${newDeliveryDate}${reasonStr}`;

  const promises = docsToUpdate.map(item => {
    const docRef = doc(db, COLLECTION, item.id);
    const existing = (item.comment || item.comments || '').trim();
    const newComment = existing ? `${existing}\n${logEntry}` : logEntry;
    return updateDoc(docRef, {
      deliveryDate: newDeliveryDate,
      endDate: newDeliveryDate,
      originalDeliveryDate: item.originalDeliveryDate || originalDelivery,
      comment: newComment,
      lastModified: Date.now()
    });
  });

  await Promise.all(promises);
}

/**
 * Records an action in the audit logs collection.
 */
export async function createAuditLog(db, user, action, projectDetails) {
  if (!user) return;
  const logRef = doc(collection(db, LOGS_COLLECTION));
  await setDoc(logRef, {
    timestamp: Date.now(),
    user: user.email || user.username || 'Desconocido',
    action,
    projectDetails
  });
}

/**
 * Updates project-wide metadata (name, responsible, client, dates, realProgress) across its documents.
 */
export async function updateProjectMeta(db, projectId, newName, newResponsible, newClient, startDate, deliveryDate, state, inferredPhase, realProgress) {
  const finalNewName = (newName || '').replace(/\s+/g, ' ').trim();
  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const docsToUpdate = snapshot.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.projectId === projectId || (p.project === projectId && !p.projectId) || p.id === projectId);

  const promises = docsToUpdate.map(item => {
    const docRef = doc(db, COLLECTION, item.id);
    const updates = {
      project: finalNewName,
      name: finalNewName,
      lastModified: Date.now()
    };
    if (newResponsible !== undefined) updates.responsible = newResponsible;
    if (newClient !== undefined) updates.client = newClient;
    if (startDate !== undefined) updates.startDate = startDate;
    if (deliveryDate !== undefined) {
      updates.deliveryDate = deliveryDate;
      updates.endDate = deliveryDate;
    }
    if (state !== undefined) updates.state = state;
    if (inferredPhase !== undefined) updates.inferredPhase = inferredPhase;
    if (realProgress !== undefined) {
      updates.realProgress = Number(realProgress);
      updates.progress = Number(realProgress);
    }

    return updateDoc(docRef, updates);
  });

  await Promise.all(promises);
}

/**
 * Appends a new update / comment to a project across its Firestore documents.
 */
export async function addProjectComment(db, projectId, commentText) {
  if (!commentText || !commentText.trim()) return;

  const today = new Date();
  const d = String(today.getDate()).padStart(2, '0');
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const y = today.getFullYear();
  const dateStr = `${d}/${m}/${y}`;

  const formattedEntry = `${dateStr}: ${commentText.trim()}`;

  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const docsToUpdate = snapshot.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.projectId === projectId || (p.project === projectId && !p.projectId) || p.id === projectId);

  if (docsToUpdate.length === 0) return;

  const promises = docsToUpdate.map(item => {
    const docRef = doc(db, COLLECTION, item.id);
    const existing = (item.comment || item.comments || '').trim();
    const newComment = existing ? `${existing}\n${formattedEntry}` : formattedEntry;
    return updateDoc(docRef, {
      comment: newComment,
      lastModified: Date.now()
    });
  });

  await Promise.all(promises);
}

/**
 * Soft-deletes a project by marking its documents as archived.
 */
export async function archiveProject(db, projectId, user) {
  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const docsToUpdate = snapshot.docs
    .filter(d => {
      const data = d.data();
      return data.projectId === projectId || (data.project === projectId && !data.projectId) || d.id === projectId;
    });

  if (docsToUpdate.length > 0) {
    const projData = docsToUpdate[0].data();
    await createAuditLog(db, user, 'ARCHIVE', {
      id: projectId,
      name: projData.project || projData.name,
      client: projData.client
    });
  }

  const promises = docsToUpdate.map(d => updateDoc(d.ref, { isArchived: true, lastModified: Date.now() }));
  await Promise.all(promises);
}

/**
 * Restores a soft-deleted project by removing the archived mark.
 */
export async function restoreProject(db, projectId, user) {
  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const docsToUpdate = snapshot.docs
    .filter(d => {
      const data = d.data();
      return data.projectId === projectId || (data.project === projectId && !data.projectId) || d.id === projectId;
    });

  if (docsToUpdate.length > 0) {
    const projData = docsToUpdate[0].data();
    await createAuditLog(db, user, 'RESTORE', {
      id: projectId,
      name: projData.project || projData.name,
      client: projData.client
    });
  }

  const promises = docsToUpdate.map(d => updateDoc(d.ref, { isArchived: false, lastModified: Date.now() }));
  await Promise.all(promises);
}

/**
 * Permanently deletes a project by removing all its documents from Firestore.
 */
export async function deleteProjectPermanently(db, projectId, user) {
  console.log("data.js: Iniciando eliminación física de:", projectId);
  const colRef = collection(db, COLLECTION);
  const q = query(colRef, where("projectId", "==", projectId));
  let snapshot = await getDocs(q);

  if (snapshot.empty) {
    const qLegacy = query(colRef, where("project", "==", projectId));
    snapshot = await getDocs(qLegacy);
  }

  if (snapshot.empty) {
    console.warn("data.js: No se encontraron documentos para el proyecto:", projectId);
    return;
  }

  const projData = snapshot.docs[0].data();
  await createAuditLog(db, user, 'DELETE_PERMANENT', {
    id: projectId,
    name: projData.project || projData.name,
    client: projData.client
  });

  const promises = snapshot.docs.map(d => deleteDoc(d.ref));
  await Promise.all(promises);
  console.log("data.js: Borrado completado.");
}

/**
 * Aggregates raw phases / project documents into unified view models.
 * Calculates automatic calendar-based progress and health metrics.
 */
export function aggregateProjectData(phases) {
  const projects = {};

  phases.forEach(item => {
    const groupingKey = item.projectId || (item.project || item.name || '').replace(/\s+/g, ' ').trim();

    if (!projects[groupingKey]) {
      projects[groupingKey] = {
        id: groupingKey,
        name: (item.project || item.name || '').replace(/\s+/g, ' ').trim(),
        client: item.client || 'General',
        responsible: item.responsible || '',
        startDate: item.startDate || '',
        deliveryDate: item.deliveryDate || item.endDate || '',
        state: item.state || 'En curso',
        inferredPhase: item.inferredPhase || '',
        phases: [],
        overallProgress: 0,
        status: 'En curso',
        isSingleCycle: item.isSingleCycle || false,
        comments: item.comments || item.comment || ''
      };
    }

    const proj = projects[groupingKey];
    proj.phases.push(item);

    if (item.responsible && !proj.responsible) {
      proj.responsible = item.responsible;
    }
    if (item.inferredPhase) {
      proj.inferredPhase = item.inferredPhase;
    }
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  Object.values(projects).forEach(proj => {
    // Strictly take earliest start date and latest delivery/end date across all phases
    const allStarts = proj.phases.map(p => parseDate(p.startDate)).filter(Boolean);
    const allEnds = proj.phases.map(p => parseDate(p.endDate || p.deliveryDate)).filter(Boolean);

    if (allStarts.length > 0) {
      const minStart = new Date(Math.min(...allStarts));
      proj.startDate = `${String(minStart.getDate()).padStart(2, '0')}/${String(minStart.getMonth() + 1).padStart(2, '0')}/${minStart.getFullYear()}`;
    }
    if (allEnds.length > 0) {
      const maxEnd = new Date(Math.max(...allEnds));
      proj.deliveryDate = `${String(maxEnd.getDate()).padStart(2, '0')}/${String(maxEnd.getMonth() + 1).padStart(2, '0')}/${maxEnd.getFullYear()}`;
    }

    // Determine immutable originalDeliveryDate
    const itemWithOrig = proj.phases.find(p => p.originalDeliveryDate);
    if (itemWithOrig && itemWithOrig.originalDeliveryDate) {
      proj.originalDeliveryDate = itemWithOrig.originalDeliveryDate;
    } else if (!proj.originalDeliveryDate) {
      proj.originalDeliveryDate = proj.deliveryDate;
    }

    const origDateObj = parseDate(proj.originalDeliveryDate);
    const deliveryDateObj = parseDate(proj.deliveryDate);

    // Calculate how many days the project has been postponed
    if (origDateObj && deliveryDateObj && deliveryDateObj > origDateObj) {
      const diffMs = deliveryDateObj.getTime() - origDateObj.getTime();
      proj.postponedDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    } else {
      proj.postponedDays = 0;
    }

    const phaseOrder = ['Levantamiento', 'Desarrollo', 'Testing/QA', 'Entrega', 'Ciclo Principal'];
    proj.phases.sort((a, b) => phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase));

    const isCompleted = proj.state === 'Completado' || proj.state === 'Finalizado' ||
      (proj.phases.length > 0 && proj.phases.every(p => p.state === 'Finalizado' || p.state === 'Completado'));

    // Automatic time-based progress (Calendario consumido)
    let timeProgress = calculateTimeProgress(proj.startDate, proj.deliveryDate);
    if (isCompleted) {
      timeProgress = 100;
      proj.status = 'Completado';
    } else {
      proj.status = 'En curso';
    }
    proj.timeProgress = timeProgress;

    // Real progress (Reportado / Estimado IA o Manual)
    const itemWithReal = proj.phases.find(p => p.realProgress !== undefined && p.realProgress !== null);
    let realProgress = 0;
    if (isCompleted) {
      realProgress = 100;
    } else if (itemWithReal && itemWithReal.realProgress !== undefined) {
      realProgress = Number(itemWithReal.realProgress);
    } else if (proj.phases.length > 0 && proj.phases[0].progress !== undefined && proj.phases[0].progress !== null) {
      realProgress = Number(proj.phases[0].progress);
    } else {
      realProgress = timeProgress;
    }
    proj.realProgress = Math.min(100, Math.max(0, Math.round(realProgress)));
    proj.overallProgress = proj.realProgress; // maintain backward compatibility
    proj.progressGap = proj.timeProgress - proj.realProgress;

    if (deliveryDateObj) {
      const diffTime = deliveryDateObj.getTime() - today.getTime();
      proj.daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    } else {
      proj.daysRemaining = null;
    }

    // Health calculation
    if (isCompleted) {
      proj.health = 'completed';
      proj.healthLabel = 'Completado';
    } else {
      let isDelayed = false;
      let isAtRisk = false;

      if (deliveryDateObj && deliveryDateObj < today) {
        isDelayed = true;
      }

      const allComments = proj.phases.map(p => p.comment || '').join(' ') + ' ' + (proj.comments || '');
      if (allComments.includes('🔴') || allComments.toLowerCase().includes('bloqueado')) {
        isAtRisk = true;
      } else if (proj.daysRemaining !== null && proj.daysRemaining <= 7 && proj.realProgress < 75) {
        isAtRisk = true;
      } else if (proj.progressGap >= 25 && proj.timeProgress > 40) {
        isAtRisk = true;
      }

      if (isDelayed) {
        proj.health = 'delayed';
        proj.healthLabel = 'Retrasado';
      } else if (isAtRisk) {
        proj.health = 'at_risk';
        proj.healthLabel = 'En Riesgo';
      } else {
        proj.health = 'on_track';
        proj.healthLabel = 'A Tiempo';
      }
    }

    if (!proj.inferredPhase) {
      proj.inferredPhase = isCompleted ? 'Completado' : 'En curso';
    }
    proj.currentPhase = proj.inferredPhase;

    proj.isArchived = proj.phases.some(p => p.isArchived === true);
    proj.lastModified = Math.max(...proj.phases.map(p => p.lastModified || 0), proj.lastModified || 0);
  });

  return Object.values(projects);
}

/**
 * Retrieves the user's role and profile from Firestore.
 */
export async function getUserRole(db, uid) {
  try {
    const roleRef = doc(db, ROLES_COLLECTION, uid);
    const roleSnap = await getDoc(roleRef);
    if (roleSnap.exists()) {
      const data = roleSnap.data();
      return data.role || 'editor';
    }
    return 'editor';
  } catch (error) {
    console.error("Error al obtener rol:", error);
    return 'editor';
  }
}

/**
 * Retrieves full user profile from Firestore.
 */
export async function getUserProfile(db, uid) {
  try {
    const roleRef = doc(db, USERS_COLLECTION, uid);
    const roleSnap = await getDoc(roleRef);
    if (roleSnap.exists()) {
      return roleSnap.data();
    }
    return null;
  } catch (error) {
    console.error("Error al obtener perfil:", error);
    return null;
  }
}

/**
 * Subscribes to real-time user list from Firestore.
 */
export function subscribeToUsers(db, callback) {
  const colRef = collection(db, USERS_COLLECTION);
  return onSnapshot(colRef, (snapshot) => {
    const users = snapshot.docs.map(d => d.data());
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    callback(users);
  });
}

/**
 * Creates or updates a user profile in Firestore.
 */
export async function saveUserProfile(db, uid, { email, displayName, role, allowedClients }) {
  const userRef = doc(db, USERS_COLLECTION, uid);
  await setDoc(userRef, {
    uid,
    email: email || '',
    displayName: displayName || '',
    role: role || 'editor',
    allowedClients: allowedClients || [],
    updatedAt: Date.now()
  }, { merge: true });
}

/**
 * Deletes a user profile from Firestore.
 */
export async function deleteUserProfile(db, uid) {
  const userRef = doc(db, USERS_COLLECTION, uid);
  await deleteDoc(userRef);
}
