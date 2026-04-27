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
  getDoc
} from "firebase/firestore";

const COLLECTION = "phases";
const CLIENTS_COLLECTION = "clients";
const ROLES_COLLECTION = "userRoles";

// Initial data to seed Firestore if collection is empty
export const initialData = [
  { project: 'Carga Subsidios/Aportes', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Levantamiento', startDate: '16/03/2026', endDate: '18/03/2026', state: 'En curso', progress: 0, comment: '' },
  { project: 'Carga Subsidios/Aportes', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Desarrollo', startDate: '19/03/2026', endDate: '24/03/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Carga Subsidios/Aportes', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Testing/QA', startDate: '25/03/2026', endDate: '26/03/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Carga Subsidios/Aportes', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Entrega', startDate: '27/03/2026', endDate: '27/03/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Gestión BBDD (ME2L PAD)', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Levantamiento', startDate: '30/03/2026', endDate: '01/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Gestión BBDD (ME2L PAD)', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Desarrollo', startDate: '02/04/2026', endDate: '07/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Gestión BBDD (ME2L PAD)', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Testing/QA', startDate: '08/04/2026', endDate: '09/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Gestión BBDD (ME2L PAD)', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Entrega', startDate: '10/04/2026', endDate: '10/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Proyecciones Masa', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Levantamiento', startDate: '13/04/2026', endDate: '15/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Proyecciones Masa', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Desarrollo', startDate: '16/04/2026', endDate: '21/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Proyecciones Masa', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Testing/QA', startDate: '22/04/2026', endDate: '23/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Proyecciones Masa', client: 'Nexus', responsible: 'Javiera Contador', phase: 'Entrega', startDate: '24/04/2026', endDate: '24/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Algoritmo EECC', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Levantamiento', startDate: '23/03/2026', endDate: '25/03/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Algoritmo EECC', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Desarrollo', startDate: '26/03/2026', endDate: '31/03/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Algoritmo EECC', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Testing/QA', startDate: '01/04/2026', endDate: '02/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Algoritmo EECC', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Entrega', startDate: '03/04/2026', endDate: '03/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reportes a Externos', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Levantamiento', startDate: '06/04/2026', endDate: '08/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reportes a Externos', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Desarrollo', startDate: '09/04/2026', endDate: '14/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reportes a Externos', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Testing/QA', startDate: '15/04/2026', endDate: '16/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reportes a Externos', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Entrega', startDate: '17/04/2026', endDate: '17/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reporte Gestión/Bench.', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Levantamiento', startDate: '20/04/2026', endDate: '22/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reporte Gestión/Bench.', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Desarrollo', startDate: '23/04/2026', endDate: '28/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reporte Gestión/Bench.', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Testing/QA', startDate: '29/04/2026', endDate: '30/04/2026', state: 'No iniciado', progress: 0, comment: '' },
  { project: 'Reporte Gestión/Bench.', client: 'Nexus', responsible: 'Felipe Toro', phase: 'Entrega', startDate: '01/05/2026', endDate: '01/05/2026', state: 'No iniciado', progress: 0, comment: '' }
];

/**
 * Seeds Firestore with the initial data if the collection is empty.
 */
export async function seedInitialDataIfEmpty(db) {
  const colRef = collection(db, COLLECTION);
  const snapshot = await getDocs(colRef);

  if (!snapshot.empty) return; // Already seeded

  const promises = initialData.map(item => {
    const id = `${item.project}-${item.phase}`.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    return setDoc(doc(db, COLLECTION, id), { ...item, id });
  });

  await Promise.all(promises);
  
  // Seed initial client
  const clientRef = doc(db, CLIENTS_COLLECTION, "mutual");
  await setDoc(clientRef, { name: "Mutual", id: "mutual", createdAt: Date.now() });
  
  console.log("Firestore seeded with initial data and Mutual client.");
}

/**
 * Subscribes to real-time Firestore updates.
 * Calls `callback` with the aggregated projects array when data changes.
 */
export function subscribeToPhases(db, callback) {
  const colRef = collection(db, COLLECTION);
  return onSnapshot(colRef, (snapshot) => {
    const phases = snapshot.docs.map(d => d.data());
    callback(phases);
  });
}

export function subscribeToClients(db, callback) {
  const colRef = collection(db, CLIENTS_COLLECTION);
  return onSnapshot(colRef, (snapshot) => {
    const clients = snapshot.docs.map(d => d.data());
    // Sort by creation or name
    clients.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    callback(clients);
  });
}

export async function addClient(db, name) {
  const id = name.toLowerCase().replace(/[^a-z0-9]/gi, '-');
  const clientRef = doc(db, CLIENTS_COLLECTION, id);
  await setDoc(clientRef, { name, id, createdAt: Date.now() });
}

export async function runMigrationToMutual(db) {
  console.log("data.js: Iniciando migración masiva a 'Mutual'...");
  const colRef = collection(db, COLLECTION);
  const snapshot = await getDocs(colRef);
  
  const phasesToMigrate = snapshot.docs.filter(d => {
    const data = d.data();
    return data.client !== "Mutual";
  });

  if (phasesToMigrate.length === 0) {
    console.log("data.js: No hay fases que migrar.");
    return;
  }

  const promises = phasesToMigrate.map(d => updateDoc(d.ref, { client: "Mutual" }));
  await Promise.all(promises);
  
  // Also ensure Mutual client exists
  await addClient(db, "Mutual");
  
  console.log(`data.js: Migración completada. ${phasesToMigrate.length} fases actualizadas.`);
}

/**
 * Updates a single phase document in Firestore.
 */
export async function updatePhase(db, phaseId, updates) {
  const phaseRef = doc(db, COLLECTION, phaseId);
  await updateDoc(phaseRef, { ...updates, lastModified: Date.now() });
}

/**
 * Creates a new project with 4 default phases in Firestore.
 */
export async function createNewProject(db, projectName, clientName = 'General', phases = ['Levantamiento', 'Desarrollo', 'Testing/QA', 'Entrega']) {
  const timestamp = Date.now();
  const selectedPhases = (phases && phases.length > 0) ? phases : ['Levantamiento', 'Desarrollo', 'Testing/QA', 'Entrega'];
  
  const promises = selectedPhases.map(phaseName => {
    // Unique ID for each phase using timestamp to avoid collisions
    const id = `${projectName}-${phaseName}-${timestamp}`.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const phaseData = {
      id,
      project: projectName,
      client: clientName,
      phase: phaseName,
      responsible: '',
      startDate: '',
      endDate: '',
      state: 'No iniciado',
      progress: 0,
      comment: '',
      isArchived: false,
      lastModified: timestamp
    };
    return setDoc(doc(db, COLLECTION, id), phaseData);
  });

  await Promise.all(promises);
}

/**
 * Updates project-wide metadata (name or responsible) across all its phases.
 */
export async function updateProjectMeta(db, oldName, newName, newResponsible) {
  const finalNewName = (newName || '').replace(/\s+/g, ' ').trim();
  const finalOldName = (oldName || '').replace(/\s+/g, ' ').trim();
  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const phasesToUpdate = snapshot.docs
    .map(d => d.data())
    .filter(p => p.project === oldName);

  const promises = phasesToUpdate.map(phase => {
    const phaseRef = doc(db, COLLECTION, phase.id);
    return updateDoc(phaseRef, {
      project: finalNewName,
      responsible: newResponsible,
      lastModified: Date.now()
    });
  });

  await Promise.all(promises);
}

/**
 * Soft-deletes a project by marking all its phases as archived.
 */
export async function archiveProject(db, projectName) {
  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const phasesToUpdate = snapshot.docs
    .filter(d => d.data().project === projectName);

  const promises = phasesToUpdate.map(d => updateDoc(d.ref, { isArchived: true, lastModified: Date.now() }));
  await Promise.all(promises);
}

/**
 * Restores a soft-deleted project by removing the archived mark from its phases.
 */
export async function restoreProject(db, projectName) {
  const q = collection(db, COLLECTION);
  const snapshot = await getDocs(q);
  const phasesToUpdate = snapshot.docs
    .filter(d => d.data().project === projectName);

  const promises = phasesToUpdate.map(d => updateDoc(d.ref, { isArchived: false, lastModified: Date.now() }));
  await Promise.all(promises);
}

/**
 * Permanently deletes a project by removing all its phase documents from Firestore.
 */
export async function deleteProjectPermanently(db, projectName) {
  console.log("data.js: Iniciando eliminación física de:", projectName);
  const colRef = collection(db, COLLECTION);
  const q = query(colRef, where("project", "==", projectName));
  const snapshot = await getDocs(q);
  
  if (snapshot.empty) {
    console.warn("data.js: No se encontraron fases para el proyecto:", projectName);
    return;
  }

  console.log(`data.js: Borrando ${snapshot.size} documentos...`);
  const promises = snapshot.docs.map(d => deleteDoc(d.ref));
  await Promise.all(promises);
  console.log("data.js: Borrado completado.");
}

/**
 * Aggregates raw phases into grouped project view models.
 */
export function aggregateProjectData(phases) {
  const projects = {};

  phases.forEach(item => {
    const projName = (item.project || '').replace(/\s+/g, ' ').trim();
    if (!projects[projName]) {
      projects[projName] = {
        name: projName,
        client: item.client || 'General',
        responsible: item.responsible,
        phases: [],
        overallProgress: 0,
        status: 'No iniciado'
      };
    }
    projects[projName].phases.push(item);
  });

  // Sort phases in logical order
  const phaseOrder = ['Levantamiento', 'Desarrollo', 'Testing/QA', 'Entrega'];
  Object.values(projects).forEach(proj => {
    proj.phases.sort((a, b) => phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase));

    const totalProgress = proj.phases.reduce((sum, p) => sum + (p.progress || 0), 0);
    proj.overallProgress = Math.round(totalProgress / proj.phases.length);

    const allDone = proj.phases.every(p => p.state === 'Finalizado') && proj.overallProgress === 100;
    const anyStarted = proj.phases.some(p => p.state === 'En curso' || p.state === 'Finalizado');

    if (allDone) {
      proj.status = 'Completado';
    } else if (anyStarted || proj.overallProgress > 0) {
      proj.status = 'En curso';
    } else {
      proj.status = 'No iniciado';
    }

    // Determine if the project is archived (if any phase is marked as archived)
    proj.isArchived = proj.phases.some(p => p.isArchived === true);

    // Track when project was last modified (max across all phases)
    proj.lastModified = Math.max(...proj.phases.map(p => p.lastModified || 0));
  });

  return Object.values(projects);
}

/**
 * Retrieves the user's role from Firestore.
 */
export async function getUserRole(db, uid) {
  try {
    const roleRef = doc(db, ROLES_COLLECTION, uid);
    const roleSnap = await getDoc(roleRef);
    if (roleSnap.exists()) {
      return roleSnap.data().role || 'user';
    }
    return 'user';
  } catch (error) {
    console.error("Error al obtener rol:", error);
    return 'user';
  }
}
