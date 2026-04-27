import './style.css';
import { db, auth } from './firebase.js';
import {
  seedInitialDataIfEmpty,
  subscribeToPhases,
  subscribeToClients,
  addClient,
  updatePhase,
  aggregateProjectData,
  createNewProject,
  updateProjectMeta,
  archiveProject,
  restoreProject,
  deleteProjectPermanently,
  getUserRole
} from './data.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';

// Application State
let appState = {
  rawPhases: [],
  projects: [],
  searchQuery: '',
  selectedParticipant: null,
  selectedStatuses: new Set(),
  sortOrder: 'name_asc',
  needsResort: true,
  frozenActiveIds: null,
  frozenArchivedIds: null,
  unsubscribe: null,
  selectedClient: null,
  clients: [],
  fpStart: null,
  fpEnd: null,
  expandedProjects: new Set(),
  currentUser: null,
  currentUserRole: null,
};

// DOM Elements
const dashboardEl = document.getElementById('dashboard');
const projectsListEl = document.getElementById('projectsList');
const searchInput = document.getElementById('searchInput');
const participantFiltersEl = document.getElementById('participantFilters');
const papeleraSection = document.getElementById('papeleraSection');
const archivedProjectsListEl = document.getElementById('archivedProjectsList');
const statusFiltersEl = document.getElementById('statusFilters');
const modalOverlay = document.getElementById('editModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const cancelBtn = document.getElementById('cancelBtn');
const editForm = document.getElementById('editForm');
const editProgressRange = document.getElementById('editProgressRange');
const editProgressValue = document.getElementById('editProgressValue');

// Date helpers: convert between DD/MM/YYYY (stored) and YYYY-MM-DD (HTML input)
function toInputDate(ddmmyyyy) {
  if (!ddmmyyyy) return '';
  const [d, m, y] = ddmmyyyy.split('/');
  return `${y}-${m}-${d}`;
}
function fromInputDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  const [y, m, d] = yyyymmdd.split('-');
  return `${d}/${m}/${y}`;
}
function formatDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .substring(0, 3);
}
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}
function adjustToWeekday(date, direction = 1) {
  const d = new Date(date);
  while (isWeekend(d)) {
    d.setDate(d.getDate() + direction);
  }
  return d;
}

// Loading state
function showLoading() {
  projectsListEl.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; padding: 4rem; gap: 1rem; color: var(--text-muted);">
      <div class="spinner"></div>
      <p>Conectando con Firestore...</p>
    </div>
  `;
  dashboardEl.innerHTML = `
    <div class="glass-card metric-card metric-total" style="opacity: 0.5;"><span class="metric-title">Cargando...</span><span class="metric-value">—</span></div>
    <div class="glass-card metric-card metric-health" style="opacity: 0.5;"><span class="metric-title">Cargando...</span><span class="metric-value">—</span></div>
    <div class="glass-card metric-card metric-progress" style="opacity: 0.5;"><span class="metric-title">Cargando...</span><span class="metric-value">—</span></div>
  `;
}

// Initialize Application
async function init() {
  showLoading();

  try {
    await seedInitialDataIfEmpty(db);
  } catch (e) {
    console.error("Error seeding data:", e);
  }

  // Watch auth state
  onAuthStateChanged(auth, async (user) => {
    appState.currentUser = user;
    if (user) {
      appState.currentUserRole = await getUserRole(db, user.uid);
    } else {
      appState.currentUserRole = null;
    }
    applyAuthUI(user);
    render();
  });

  // Subscribe to real-time updates: PHASES
  appState.unsubscribe = subscribeToPhases(db, (phases) => {
    appState.rawPhases = phases;
    appState.projects = aggregateProjectData(phases);
    render();
  });

  // Subscribe to real-time updates: CLIENTS
  subscribeToClients(db, (clients) => {
    appState.clients = clients;
    
    // Set default client if none selected
    if (!appState.selectedClient && clients.length > 0) {
      // Restore from localStorage first, then fallback to Mutual, then first
      const savedClient = localStorage.getItem('selectedClient');
      const restoredClient = savedClient && clients.find(c => c.name === savedClient);
      if (restoredClient) {
        appState.selectedClient = restoredClient.name;
      } else {
        const mutual = clients.find(c => c.name === 'Mutual');
        appState.selectedClient = mutual ? mutual.name : clients[0].name;
      }
    }
    
    render();
  });
  // Migration completely resolved; skipping one-time migration script

  setupEventListeners();
  setupAuthListeners();
}

// ─── Auth UI ────────────────────────────────────────────────────────────────
function applyAuthUI(user) {
  const loginBtn  = document.getElementById('loginBtn');
  const userInfo  = document.getElementById('userInfo');
  const userEmail = document.getElementById('userEmail');
  const userAvatar = document.getElementById('userAvatar');
  const addProjectBtn = document.getElementById('addProjectBtn');
  const backupBtn = document.getElementById('backupBtn');

  if (user) {
    // Logged in
    if (loginBtn)  loginBtn.style.display  = 'none';
    if (userInfo)  userInfo.style.display  = 'flex';
    if (userEmail) userEmail.textContent   = user.email;
    if (userAvatar) userAvatar.textContent = user.email[0].toUpperCase();
    if (addProjectBtn) addProjectBtn.style.display = '';
    if (backupBtn) backupBtn.style.display = 'flex';
  } else {
    // Logged out
    if (loginBtn)  loginBtn.style.display  = 'flex';
    if (userInfo)  userInfo.style.display  = 'none';
    if (addProjectBtn) addProjectBtn.style.display = 'none';
    if (backupBtn) backupBtn.style.display = 'none';
  }
}

// ─── Auth Listeners ─────────────────────────────────────────────────────────
function setupAuthListeners() {
  const loginBtn     = document.getElementById('loginBtn');
  const loginModal   = document.getElementById('loginModal');
  const closeLoginBtn = document.getElementById('closeLoginBtn');
  const loginForm    = document.getElementById('loginForm');
  const loginError   = document.getElementById('loginError');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');
  const logoutBtn    = document.getElementById('logoutBtn');
  const togglePwdBtn = document.getElementById('togglePassword');
  const loginPassword = document.getElementById('loginPassword');

  const openLoginModal = () => loginModal?.classList.add('active');
  const closeLoginModal = () => {
    loginModal?.classList.remove('active');
    if (loginError) loginError.style.display = 'none';
    if (loginForm) loginForm.reset();
  };

  loginBtn?.addEventListener('click', openLoginModal);
  closeLoginBtn?.addEventListener('click', closeLoginModal);
  loginModal?.addEventListener('click', (e) => { if (e.target === loginModal) closeLoginModal(); });

  // Toggle password visibility
  togglePwdBtn?.addEventListener('click', () => {
    if (!loginPassword) return;
    loginPassword.type = loginPassword.type === 'password' ? 'text' : 'password';
  });

  // Login submit
  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail')?.value.trim();
    const password = loginPassword?.value;
    if (!email || !password) return;

    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = 'Verificando...';
    if (loginError) loginError.style.display = 'none';

    try {
      await signInWithEmailAndPassword(auth, email, password);
      closeLoginModal();
    } catch (err) {
      let msg = 'Error al iniciar sesión. Intenta de nuevo.';
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        msg = 'Correo o contraseña incorrectos.';
      } else if (err.code === 'auth/too-many-requests') {
        msg = 'Demasiados intentos fallidos. Espera unos minutos.';
      } else if (err.code === 'auth/invalid-email') {
        msg = 'El formato del correo no es válido.';
      }
      if (loginError) { loginError.textContent = msg; loginError.style.display = 'block'; }
    } finally {
      loginSubmitBtn.disabled = false;
      loginSubmitBtn.textContent = 'Iniciar sesión';
    }
  });

  // Logout
  logoutBtn?.addEventListener('click', async () => {
    await signOut(auth);
  });
}

// Render the UI
function render() {
  renderClientTabs();
  renderGantt();
  renderStatusFilters();
  renderDashboard();
  renderProjects();
}

// ─── Shared Gantt Utilities ─────────────────────────────────────────────────
function getWorkingDaysBetween(start, end) {
  if (!start || !end) return 0;
  let d = new Date(start);
  const endD = new Date(end);
  d.setHours(0, 0, 0, 0);
  endD.setHours(0, 0, 0, 0);
  
  if (d > endD) return 0;
  
  let count = 0;
  while (d <= endD) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      count++;
    }
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/');
  return new Date(+y, +m - 1, +d);
}
function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
const MONTH_LABELS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function weekLabel(date) {
  return `${date.getDate()} ${MONTH_LABELS[date.getMonth()]}`;
}
const GANTT_COLORS = ['#6366f1','#14b8a6','#ec4899','#f59e0b','#3b82f6','#8b5cf6'];
const PHASE_COLORS = { 'Levantamiento':'#6366f1', 'Desarrollo':'#14b8a6', 'Testing/QA':'#ec4899', 'Entrega':'#f59e0b' };

function getWeeksForPhases(phases) {
  let allDates = [];
  phases.forEach(p => {
    const s = parseDate(p.startDate);
    const e = parseDate(p.endDate);
    if (s) allDates.push(s);
    if (e) allDates.push(e);
  });
  if (allDates.length === 0) return [];
  const minDate = weekStart(new Date(Math.min(...allDates)));
  const maxDate = new Date(Math.max(...allDates));
  const weeks = [];
  const cursor = new Date(minDate);
  while (cursor <= maxDate) { weeks.push(new Date(cursor)); cursor.setDate(cursor.getDate() + 7); }
  weeks.push(new Date(cursor)); // buffer
  return weeks;
}

function getGlobalWeeks() {
  return getWeeksForPhases(appState.rawPhases);
}

// ─── Gantt Chart ───────────────────────────────────────────────────────────
// ─── Client Tabs ───────────────────────────────────────────────────────────
function renderClientTabs() {
  const container = document.getElementById('clientTabs');
  if (!container) return;

  const clients = appState.clients;
  if (clients.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  const canEdit = !!appState.currentUser;

  const tabsHtml = clients.map(c => {
    const isActive = appState.selectedClient === c.name;
    const count = appState.projects.filter(p => p.client === c.name && !p.isArchived).length;
    return `
      <button class="client-tab ${isActive ? 'active' : ''}" onclick="window.setClient('${c.name}')">
        ${c.name}
        <span class="count">${count}</span>
      </button>
    `;
  }).join('');

  const addButtonHtml = canEdit ? `
    <button class="client-tab" onclick="window.addNewClient()" style="padding: 0.6rem 1rem; color: var(--accent-primary); border-left: 1px solid var(--card-border); margin-left: auto;">
      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    </button>
  ` : '';

  container.innerHTML = tabsHtml + addButtonHtml;
}

window.addNewClient = function() {
  const modal = document.getElementById('clientModal');
  const input = document.getElementById('newClientName');
  if (modal && input) {
    input.value = '';
    modal.classList.add('active');
    setTimeout(() => input.focus(), 100);
  }
};

function closeClientModal() {
  const modal = document.getElementById('clientModal');
  if (modal) modal.classList.remove('active');
}

window.setClient = function(client) {
  appState.selectedClient = client;
  localStorage.setItem('selectedClient', client);
  render();
  // Smooth scroll to dashboard when switching clients
  const dashboard = document.getElementById('dashboard');
  if (dashboard) {
    dashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

window.scrollToProject = function(safeId) {
  const card = document.getElementById(`project-card-${safeId}`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Brief highlight pulse to draw the eye
  card.style.transition = 'box-shadow 0.3s ease, outline 0.3s ease';
  card.style.outline = '2px solid var(--accent-primary)';
  card.style.boxShadow = '0 0 24px var(--accent-primary)55';
  setTimeout(() => {
    card.style.outline = '';
    card.style.boxShadow = '';
  }, 1500);
};

/**
 * Calculates the position of the "today" line in a Gantt chart.
 */
function getTodayX(weeks, labelW, colW) {
  if (!weeks || weeks.length === 0) return null;

  const now = new Date();
  // Represent today as a y/m/d key — completely immune to DST timestamp issues
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const dateKey  = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  // Find which week bucket today falls into by comparing date keys
  const weekIdx = weeks.findIndex((w, i) => {
    const wStart = w;
    const wEnd   = weeks[i + 1] ?? new Date(w.getTime() + 7 * 86400000);
    // Compare date-only (ignores time/DST):
    const todayNum  = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const startNum  = wStart.getFullYear() * 10000 + (wStart.getMonth() + 1) * 100 + wStart.getDate();
    const endD      = new Date(wEnd.getTime() - 1); // one ms before next week start
    const endNum    = endD.getFullYear() * 10000 + (endD.getMonth() + 1) * 100 + endD.getDate();
    return todayNum >= startNum && todayNum <= endNum;
  });

  if (weekIdx === -1) return null;

  // Day-of-week fraction using the same working-day scale as bars (5 days/column)
  // dayOfWeek: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  const dow = now.getDay();
  let fraction;
  if      (dow === 0) fraction = 0;        // Sunday  → start of week
  else if (dow === 6) fraction = 1;        // Saturday → end of week
  else                fraction = (dow - 1) / 5; // Mon→0, Tue→0.2 … Fri→0.8

  // Return percentage based on total width to handle proportional scaling of the table
  const totalW = labelW + weeks.length * colW;
  const currentX = labelW + (weekIdx * colW) + (fraction * colW);
  return (currentX / totalW) * 100 + '%';
}

function renderGantt() {
  const ganttEl = document.getElementById('ganttChart');
  const activeProjects = appState.projects.filter(p => !p.isArchived && 
    p.client === appState.selectedClient &&
    (appState.selectedStatuses.size === 0 || appState.selectedStatuses.has(p.status))
  );
  
  if (!ganttEl || appState.rawPhases.length === 0) return;

  const weeks = getGlobalWeeks();
  if (weeks.length === 0) { ganttEl.innerHTML = ''; return; }
  const totalWeeks = weeks.length;
  const ROW_H = 52, COL_W = 80, LABEL_W = 240;

  const headerCells = weeks.map(w =>
    `<th style="min-width:${COL_W}px; padding: 0.6rem 0 0.6rem 6px; font-size:0.72rem; font-weight:600; color:var(--text-muted); text-align:left; background:rgba(0,0,0,0.25); border-left:1px solid var(--card-border); white-space:nowrap;">${weekLabel(w)}</th>`
  ).join('');

  const rowsHtml = activeProjects.map((proj, i) => {
    const phaseDates = proj.phases.flatMap(ph => [parseDate(ph.startDate), parseDate(ph.endDate)]).filter(Boolean);
    if (phaseDates.length === 0) return '';
    const startWeek = weekStart(new Date(Math.min(...phaseDates)));
    const endWeek   = weekStart(new Date(Math.max(...phaseDates)));
    const startCol  = weeks.findIndex(w => w.getTime() === startWeek.getTime());
    let   endCol    = weeks.findIndex(w => w.getTime() === endWeek.getTime());
    if (endCol === -1) endCol = totalWeeks - 1;
    const span  = Math.max(1, endCol - startCol + 1);
    
    // Precise visual offset and width calculation (WORKING DAYS ONLY)
    const minPhaseDate = new Date(Math.min(...phaseDates));
    const maxPhaseDate = new Date(Math.max(...phaseDates));
    
    let offsetDays = 0;
    if (minPhaseDate > startWeek) {
      offsetDays = Math.max(0, getWorkingDaysBetween(startWeek, minPhaseDate) - 1);
    }
    
    const durationDays = Math.max(1, getWorkingDaysBetween(minPhaseDate, maxPhaseDate));
    const spanDays = span * 5; // 5 working days per week column
    
    let offsetPercent = (offsetDays / spanDays) * 100;
    let widthPercent = (durationDays / spanDays) * 100;
    if (widthPercent + offsetPercent > 100) widthPercent = 100 - offsetPercent;
    
    let color = '#4b5563'; // Opaco para No iniciado
    if (proj.status === 'En curso') {
      color = '#10b981'; // Verde
    } else if (proj.status === 'Finalizado' || proj.status === 'Completado') {
      color = '#3b82f6'; // Azul
    }

    const cells = weeks.map((_, ci) => {
      if (ci === startCol) {
        const phasesHtml = proj.phases.map((ph, idx) => {
          const phStart = parseDate(ph.startDate);
          const phEnd = parseDate(ph.endDate);
          if (!phStart || !phEnd) return '';
          
          let phOffsetDays = 0;
          if (phStart > minPhaseDate) {
            phOffsetDays = Math.max(0, getWorkingDaysBetween(minPhaseDate, phStart) - 1);
          }
          const phDurationDays = Math.max(1, getWorkingDaysBetween(phStart, phEnd));
          
          let leftPct = (phOffsetDays / durationDays) * 100;
          let wPct = (phDurationDays / durationDays) * 100;
          // Prevenir que se desborde del 100%
          if (leftPct + wPct > 100) wPct = 100 - leftPct;
          
          return `<div style="position:absolute; left:${leftPct}%; width:${wPct}%; height:100%; background:${color}; z-index:1; border-radius:999px;"></div>`;
        }).join('');

        return `<td colspan="${span}" style="padding:0.5rem 4px; border-left:1px solid rgba(255,255,255,0.04);">
          <div style="position:relative; background:${color}33; border-radius:999px; height:30px; display:flex; align-items:center; overflow:hidden; box-shadow:0 2px 8px ${color}66; margin-left:${offsetPercent}%; width:${widthPercent}%;">
            ${phasesHtml}
            <div style="position:relative; z-index:2; padding:0 1rem; font-size:0.72rem; font-weight:600; color:white; white-space:nowrap;">${proj.overallProgress}%</div>
          </div>
        </td>`;
      }
      if (ci > startCol && ci < startCol + span) return '';
      return `<td style="border-left:1px solid rgba(255,255,255,0.04);"></td>`;
    }).join('');

    const ganttSafeId = proj.name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    return `<tr style="height:${ROW_H}px;">
      <td style="min-width:${LABEL_W}px; max-width:${LABEL_W}px; padding:0 1rem; font-size:0.8rem; font-weight:600; background:${color}22; border-right:3px solid ${color}; position:sticky; left:0; z-index:2; overflow:visible; white-space:normal; line-height:1.2;">
        <span
          onclick="window.scrollToProject('${ganttSafeId}')"
          style="cursor:pointer; display:block; transition:color 0.2s, text-shadow 0.2s;"
          onmouseover="this.style.color='${color}'; this.style.textShadow='0 0 8px ${color}88';"
          onmouseout="this.style.color=''; this.style.textShadow='';">
          ${proj.name}
        </span>
      </td>
      ${cells}</tr>`;
  }).join('');

  const todayX = getTodayX(weeks, LABEL_W, COL_W);
  const todayLine = todayX !== null ? `<div class="today-line" style="left:${todayX}; height: 100%;"></div>` : '';

  const totalW = LABEL_W + totalWeeks * COL_W;
  
  ganttEl.style.position = ''; // Remove relative from scroll container to prevent absolute element from breaking
  ganttEl.innerHTML = `
    <div style="position:relative; width:100%; min-width:${totalW}px;">
      ${todayLine}
      <table style="border-collapse:collapse; width:100%; table-layout:fixed;">
      <colgroup><col style="width:${LABEL_W}px;">${weeks.map(() => `<col style="width:${COL_W}px;">`).join('')}</colgroup>
    <thead><tr>
      <th style="position:sticky; left:0; z-index:3; background:rgba(13,15,23,0.95); min-width:${LABEL_W}px; padding:0.6rem 1rem; font-size:0.75rem; font-weight:600; color:var(--text-muted); text-align:left;">Proyecto</th>
      ${headerCells}
    </tr></thead>
    <tbody style="background:rgba(0,0,0,0.1);">${rowsHtml}</tbody>
  </table>
  </div>`;
}

// ─── Per-Project Mini Gantt ────────────────────────────────────────────────
function buildPhaseGanttTable(proj, weeks, projColor) {
  if (!weeks || weeks.length === 0) return '<p style="padding:1rem; color:var(--text-muted); font-size:0.8rem;">Sin datos de semanas.</p>';
  const totalWeeks = weeks.length;
  const COL_W = 80, LABEL_W = 200;

  const headerCells = weeks.map(w =>
    `<th style="min-width:${COL_W}px; padding:0.5rem 0 0.5rem 6px; font-size:0.7rem; font-weight:600; color:var(--text-muted); text-align:left; background:rgba(0,0,0,0.3); border-left:1px solid var(--card-border); white-space:nowrap;">${weekLabel(w)}</th>`
  ).join('');

  const rowsHtml = proj.phases.map(phase => {
    const s = parseDate(phase.startDate);
    const e = parseDate(phase.endDate);
    if (!s || !e) return '';
    const startWeek = weekStart(s);
    const endWeek   = weekStart(e);
    const startCol  = weeks.findIndex(w => w.getTime() === startWeek.getTime());
    let   endCol    = weeks.findIndex(w => w.getTime() === endWeek.getTime());
    if (endCol === -1) endCol = totalWeeks - 1;
    if (startCol === -1) return '';
    const span  = Math.max(1, endCol - startCol + 1);
    const color = PHASE_COLORS[phase.phase] || projColor;

    // Precise visual offset and width calculation (WORKING DAYS ONLY)
    let offsetDays = 0;
    if (s > startWeek) {
      offsetDays = Math.max(0, getWorkingDaysBetween(startWeek, s) - 1);
    }
    
    const durationDays = Math.max(1, getWorkingDaysBetween(s, e));
    const spanDays = span * 5; // 5 working days per week column
    
    let offsetPercent = (offsetDays / spanDays) * 100;
    let widthPercent = (durationDays / spanDays) * 100;
    if (widthPercent + offsetPercent > 100) widthPercent = 100 - offsetPercent;

    const cells = weeks.map((_, ci) => {
      if (ci === startCol) return `<td colspan="${span}" style="padding:0.4rem 4px; border-left:1px solid rgba(255,255,255,0.04);">
        <div style="position:relative; height:26px; margin-left:${offsetPercent}%; width:${widthPercent}%;">
          <div title="${phase.startDate} – ${phase.endDate}" 
               style="background:${color}; opacity:0.9; border-radius:999px; height:100%; display:flex; align-items:center; justify-content:space-between; padding:0 0.75rem; font-size:0.68rem; font-weight:600; color:white; white-space:nowrap; overflow:hidden; box-shadow:0 2px 6px ${color}55;">
            <span style="overflow:hidden; text-overflow:ellipsis;">${phase.phase}</span>
            <span style="margin-left:0.5rem; opacity:0.85;">${phase.progress || 0}%</span>
          </div>
        </div></td>`;
      if (ci > startCol && ci < startCol + span) return '';
      return `<td style="border-left:1px solid rgba(255,255,255,0.04);"></td>`;
    }).join('');

    return `<tr style="height:44px;">
      <td style="min-width:${LABEL_W}px; max-width:${LABEL_W}px; padding:0 0.75rem; font-size:0.75rem; font-weight:600; color:var(--text-muted); background:rgba(0,0,0,0.15); border-right:2px solid ${color}44; position:sticky; left:0; z-index:2; overflow:visible; white-space:normal; line-height:1.2;">${phase.phase}</td>
      ${cells}</tr>`;
  }).join('');

  const todayX = getTodayX(weeks, LABEL_W, COL_W);
  const todayLine = todayX !== null ? `<div class="today-line" style="left:${todayX}; height: 100%;"></div>` : '';

  const totalW = LABEL_W + totalWeeks * COL_W;
  return `
    <div style="position:relative; width:100%; min-width:${totalW}px;">
      ${todayLine}
      <table style="border-collapse:collapse; width:100%; table-layout:fixed;">
        <colgroup><col style="width:${LABEL_W}px;">${weeks.map(() => `<col style="width:${COL_W}px;">`).join('')}</colgroup>
        <thead><tr>
          <th style="position:sticky; left:0; z-index:3; background:rgba(10,12,20,0.98); min-width:${LABEL_W}px; padding:0.5rem 0.75rem; font-size:0.7rem; font-weight:600; color:var(--text-muted); text-align:left;">Fase</th>
          ${headerCells}
        </tr></thead>
        <tbody style="background:rgba(0,0,0,0.15);">${rowsHtml}</tbody>
      </table>
    </div>`;
}



// ─── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const activeProjects = appState.projects.filter(p => !p.isArchived && p.client === appState.selectedClient);
  const totalProjects = activeProjects.length;
  const inProgress = activeProjects.filter(p => p.status === 'En curso').length;
  const completed = activeProjects.filter(p => p.status === 'Completado' || p.status === 'Finalizado').length;

  const avgProgress = totalProjects > 0
    ? Math.round(activeProjects.reduce((sum, p) => sum + p.overallProgress, 0) / totalProjects)
    : 0;

  dashboardEl.innerHTML = `
    <div class="glass-card metric-card metric-total">
      <span class="metric-title">Proyectos Totales</span>
      <span class="metric-value">${totalProjects}</span>
      <div style="margin-top: 0.5rem; color: var(--text-muted); font-size: 0.875rem;">
        <span style="color: var(--status-done); font-weight: 600;">${completed}</span> completados
      </div>
    </div>

    <div class="glass-card metric-card metric-health">
      <span class="metric-title">Proyectos Activos</span>
      <span class="metric-value">${inProgress}</span>
      <div style="margin-top: 0.5rem; color: var(--text-muted); font-size: 0.875rem;">
        En fase de ejecución
      </div>
    </div>

    <div class="glass-card metric-card metric-progress">
      <span class="metric-title">Avance Global</span>
      <span class="metric-value">${avgProgress}%</span>
      <div class="progress-container" style="margin-top: 1rem;">
        <div class="progress-bar" style="width: ${avgProgress}%;"></div>
      </div>
    </div>
  `;
}

function getStatusClass(status) {
  if (status === 'No iniciado') return 'status-not-started';
  if (status === 'En curso') return 'status-in-progress';
  if (status === 'Finalizado' || status === 'Completado') return 'status-done';
  return 'status-not-started';
}

function renderProjects() {
  const filteredProjects = appState.projects.filter(p => {
    const matchesClient = p.client === appState.selectedClient;
    if (!matchesClient) return false;
    
    const matchesSearch = p.name.toLowerCase().includes(appState.searchQuery.toLowerCase()) ||
                         p.responsible.toLowerCase().includes(appState.searchQuery.toLowerCase());
    const matchesParticipant = !appState.selectedParticipant || p.responsible === appState.selectedParticipant;
    return matchesSearch && matchesParticipant;
  });

  renderParticipantFilters();

  const activeProjects = filteredProjects.filter(p => !p.isArchived);
  const archivedProjects = filteredProjects.filter(p => p.isArchived);

  // Robust sorting persistence: Use global frozen IDs to maintain order across updates and filters
  // Only capture frozen order if we have data and either need a resort or haven't frozen yet
  const hasData = appState.projects.length > 0;
  if ((appState.needsResort || !appState.frozenActiveIds) && hasData) {
    const sortFn = (a, b) => {
      if (appState.sortOrder === 'date_desc') return (b.lastModified || 0) - (a.lastModified || 0);
      if (appState.sortOrder === 'date_asc') return (a.lastModified || 0) - (b.lastModified || 0);
      return a.name.localeCompare(b.name);
    };

    const sortedActive = appState.projects.filter(p => !p.isArchived).sort(sortFn);
    const sortedArchived = appState.projects.filter(p => p.isArchived).sort(sortFn);
    
    appState.frozenActiveIds = sortedActive.map(p => p.name);
    appState.frozenArchivedIds = sortedArchived.map(p => p.name);
    appState.needsResort = false;
    console.log(`main.js: Orden congelado para ${appState.frozenActiveIds.length} proyectos activos.`);
  }

  // Use the frozen order to sort the current (filtered) projects
  const applyFrozenOrder = (list, frozenIds) => {
    return list.sort((a, b) => {
      let idxA = frozenIds.indexOf(a.name);
      let idxB = frozenIds.indexOf(b.name);
      
      if (idxA === -1) console.log(`main.js: ID NO ENCONTRADO para "${a.name}" en lista de ${frozenIds.length} IDs.`);
      
      // Fallback for truly new projects not yet in our frozen memory
      if (idxA === -1 && idxB === -1) return (b.lastModified || 0) - (a.lastModified || 0);
      if (idxA === -1) return -1; 
      if (idxB === -1) return 1;
      
      return idxA - idxB;
    });
  };

  applyFrozenOrder(activeProjects, appState.frozenActiveIds);
  applyFrozenOrder(archivedProjects, appState.frozenArchivedIds);

  if (activeProjects.length === 0) {
    projectsListEl.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 2rem;">No se encontraron proyectos activos.</p>`;
  } else {
    projectsListEl.innerHTML = activeProjects.map((proj, index) => renderProjectCard(proj, index, false)).join('');
  }

  if (papeleraSection && archivedProjectsListEl) {
    if (archivedProjects.length > 0) {
      papeleraSection.style.display = 'block';
      archivedProjectsListEl.innerHTML = archivedProjects.map((proj, index) => renderProjectCard(proj, index, true)).join('');
    } else {
      papeleraSection.style.display = 'none';
      archivedProjectsListEl.innerHTML = '';
    }
  }
}

function renderProjectCard(proj, index, isArchived) {
  const globalIndex = appState.projects.findIndex(p => p.name === proj.name);
  const projColor = GANTT_COLORS[globalIndex % GANTT_COLORS.length];
  const safeId = proj.name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const isExpanded = appState.expandedProjects.has(safeId);
  const canEdit = !!appState.currentUser;

  return `
  <div id="project-card-${safeId}" class="glass-card animate-fade-in ${isArchived ? 'archived-project' : ''}" style="animation-delay: ${0.07 * (index % 6)}s">
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; flex-wrap: wrap; gap: 1rem;">
      <div>
        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem;">
          <h3 ${canEdit && !isArchived ? `class="editable-field" contenteditable="true" onblur="window.handleMetaBlur(this, '${proj.name}', 'name')"` : ''}
              onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}"
              style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0; min-width: 100px;">${proj.name}</h3>
          <span class="badge ${getStatusClass(proj.status)}">${proj.status}</span>
        </div>
        <div style="color: var(--text-muted); font-size: 0.875rem; display: flex; align-items: center; gap: 0.5rem;">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
          <span ${canEdit && !isArchived ? `class="editable-field" contenteditable="true" onblur="window.handleMetaBlur(this, '${proj.name}', 'responsible')"` : ''}
                onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}"
                style="min-width: 80px;">${proj.responsible || 'Sin asignar'}</span>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem;">
        ${canEdit
          ? (!isArchived
              ? `<button class="delete-btn js-archive-project" 
                        data-project="${proj.name}"
                        title="Archivar Proyecto">Eliminar</button>`
              : `
                <div style="display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-end;">
                  <button class="restore-btn js-restore-project" 
                          data-project="${proj.name}"
                          title="Restaurar Proyecto">Restaurar</button>
                  ${appState.currentUserRole === 'admin' ? `
                  <button class="delete-btn js-delete-permanent" 
                          data-project="${proj.name}"
                          style="background: var(--status-alert); padding: 0.25rem 0.5rem; font-size: 0.7rem;" 
                          title="Eliminar para siempre">Borrar Permanentemente</button>
                  ` : ''}
                </div>
              `)
          : ''
        }
        <span style="font-size: 1.125rem; font-weight: 700; color: var(--accent-tertiary);">${proj.overallProgress}% Global</span>
      </div>
      </div>

      <div class="progress-container" style="margin-bottom: 1.5rem; height: 6px;">
        <div class="progress-bar" style="width: ${proj.overallProgress}%;"></div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--card-border);">
        ${proj.phases.map(phase => `
          <div class="phase-card"
               style="background: rgba(0,0,0,0.2); border-radius: var(--border-radius-sm); padding: 1rem; border: 1px solid transparent; transition: border-color 0.2s, box-shadow 0.2s; cursor: ${canEdit ? 'pointer' : 'default'};"
               ${canEdit ? `onclick="window.openEditModal('${phase.id}')"` : ''}>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <strong style="font-size: 0.9rem;">${phase.phase}</strong>
              <span class="badge ${getStatusClass(phase.state)}" style="font-size: 0.65rem; padding: 0.1rem 0.5rem;">${phase.state}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.5rem;">
              <span>${phase.startDate} – ${phase.endDate}</span>
              <span style="color: white; font-weight: bold;">${phase.progress || 0}%</span>
            </div>
            <div class="progress-container" style="height: 4px; margin-top: 0; background: rgba(255,255,255,0.1);">
              <div class="progress-bar" style="width: ${phase.progress || 0}%; background: ${(phase.progress || 0) === 100 ? 'var(--status-done)' : 'var(--accent-primary)'}"></div>
            </div>
            ${phase.comment ? `
              <div style="margin-top: 0.75rem; font-size: 0.8rem; color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.05); padding: 0.5rem; border-radius: 4px; border-left: 2px solid var(--accent-secondary); white-space: pre-wrap;">${phase.comment}</div>
            ` : ''}
          </div>
        `).join('')}
      </div>

      <!-- Chevron toggle for mini Gantt -->
      <div style="display:flex; justify-content:center; margin-top:1.25rem; padding-top:0.75rem; border-top:1px solid var(--card-border);">
        <button
          id="gantt-toggle-${safeId}"
          onclick="window.toggleProjectGantt('${safeId}')"
          style="background:transparent; border:none; color:${isExpanded ? 'var(--accent-primary)' : 'var(--text-muted)'}; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:0.25rem; padding:0.25rem 1rem; transition:color 0.2s;"
          title="Ver cronograma por fases"
        >
          <span style="font-size:0.7rem; letter-spacing:0.05em; text-transform:uppercase;">Cronograma</span>
          <svg id="gantt-chevron-${safeId}" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="transition:transform 0.3s; transform: ${isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'};">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>

      <!-- Hidden per-project mini Gantt -->
      <div id="gantt-panel-${safeId}" style="display:${isExpanded ? 'block' : 'none'}; overflow-x:auto; margin-top:0; border-top:1px solid var(--card-border); background:rgba(0,0,0,0.15); border-radius:0 0 var(--border-radius-lg) var(--border-radius-lg);">
        ${buildPhaseGanttTable(proj, getWeeksForPhases(proj.phases), projColor)}
      </div>
    </div>`;
}

function renderParticipantFilters() {
  const container = document.getElementById('participantFilters');
  if (!container) return;

  const participants = [...new Set(appState.rawPhases.map(p => p.responsible))].filter(Boolean);
  
  const buttonsHtml = participants.map(name => {
    const initials = getInitials(name);
    const isActive = appState.selectedParticipant === name;
    return `
      <button class="participant-btn ${isActive ? 'active' : ''}" 
              onclick="window.setParticipantFilter('${name}')"
              title="${name}">
        ${initials}
      </button>
    `;
  }).join('');

  const allActive = !appState.selectedParticipant;
  container.innerHTML = `
    <button class="participant-btn ${allActive ? 'active' : ''}" 
            onclick="window.setParticipantFilter(null)">
      Todos
    </button>
    ${buttonsHtml}
  `;
}

function renderStatusFilters() {
  if (!statusFiltersEl) return;
  
  // Available statuses from active projects
  const availableStatuses = [...new Set(appState.projects.filter(p => !p.isArchived).map(p => p.status))].filter(Boolean);
  
  if (availableStatuses.length === 0) {
    statusFiltersEl.innerHTML = '';
    return;
  }
  
  statusFiltersEl.innerHTML = availableStatuses.map(status => {
    const isActive = appState.selectedStatuses.has(status);
    return `
      <button class="status-filter-btn" 
              onclick="window.toggleStatusFilter('${status}')"
              style="font-size: 0.75rem; font-weight: 500; padding: 0.3rem 0.8rem; border-radius: 999px; border: 1px solid var(--card-border); background: ${isActive ? 'var(--accent-primary)' : 'rgba(255,255,255,0.05)'}; color: ${isActive ? 'white' : 'var(--text-muted)'}; cursor: pointer; transition: all 0.2s;">
        ${status}
      </button>
    `;
  }).join('');
}

window.toggleStatusFilter = function(status) {
  if (appState.selectedStatuses.has(status)) {
    appState.selectedStatuses.delete(status);
  } else {
    appState.selectedStatuses.add(status);
  }
  renderGantt();
  renderStatusFilters();
};

window.toggleSortOrder = function() {
  const iconPath = document.getElementById('sortIconPath');
  const btn = document.getElementById('sortToggleBtn');
  
  if (appState.sortOrder === 'name_asc') {
    appState.sortOrder = 'date_desc';
    if (iconPath) iconPath.setAttribute('d', 'M19 9l-7 7-7-7'); // Arrow down (descendent)
    if (btn) { btn.title = "Ordenar: Modificado Reciente"; btn.style.color = "var(--accent-primary)"; btn.style.borderColor = "var(--accent-primary)"; btn.style.background = "rgba(99,102,241,0.1)"; }
  } else if (appState.sortOrder === 'date_desc') {
    appState.sortOrder = 'date_asc';
    if (iconPath) iconPath.setAttribute('d', 'M5 15l7-7 7 7'); // Arrow up (ascendent)
    if (btn) btn.title = "Ordenar: Modificado Antiguo";
  } else {
    appState.sortOrder = 'name_asc';
    if (iconPath) iconPath.setAttribute('d', 'M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12'); // Sort icon (alpha)
    if (btn) { btn.title = "Ordenar: Alfabético"; btn.style.color = "var(--text-muted)"; btn.style.borderColor = "transparent"; btn.style.background = "rgba(255,255,255,0.03)"; }
  }
  
  appState.needsResort = true;
  renderProjects();
};

window.setParticipantFilter = function(name) {
  if (appState.selectedParticipant === name) {
    appState.selectedParticipant = null;
  } else {
    appState.selectedParticipant = name;
  }
  render();
};

window.toggleProjectGantt = function(safeId) {
  const panel   = document.getElementById(`gantt-panel-${safeId}`);
  const chevron = document.getElementById(`gantt-chevron-${safeId}`);
  const btn     = document.getElementById(`gantt-toggle-${safeId}`);
  if (!panel) return;
  
  const isOpen = panel.style.display !== 'none';
  if (isOpen) {
    appState.expandedProjects.delete(safeId);
    panel.style.display = 'none';
    if (chevron) chevron.style.transform = 'rotate(0deg)';
    if (btn) btn.style.color = 'var(--text-muted)';
  } else {
    appState.expandedProjects.add(safeId);
    panel.style.display = 'block';
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    if (btn) btn.style.color = 'var(--accent-primary)';
  }
};

window.handleMetaBlur = async function(el, oldName, field) {
  const newValue = el.innerText.replace(/\s+/g, ' ').trim();
  const proj = appState.projects.find(p => p.name === oldName);
  if (!proj) return;

  const newName = field === 'name' ? newValue : proj.name;
  const newResp = field === 'responsible' ? newValue : proj.responsible;

  if (newName === proj.name && newResp === proj.responsible) {
    el.innerText = newValue; // normalize UI
    return;
  }

  // Update frozen IDs optimistically to maintain visual position even after rename
  if (field === 'name' && newName !== oldName) {
    if (appState.frozenActiveIds) {
      const idx = appState.frozenActiveIds.indexOf(oldName);
      if (idx !== -1) appState.frozenActiveIds[idx] = newName;
    }
    if (appState.frozenArchivedIds) {
      const idx = appState.frozenArchivedIds.indexOf(oldName);
      if (idx !== -1) appState.frozenArchivedIds[idx] = newName;
    }
  }

  try {
    await updateProjectMeta(db, oldName, newName, newResp);
  } catch (err) {
    console.error("Error updating meta:", err);
    // Rollback frozen IDs on error if needed (simpler: just set needsResort = true)
    appState.needsResort = true;
    el.innerText = field === 'name' ? proj.name : proj.responsible;
    alert("Error al actualizar. Se han restaurado los valores originales.");
  }
};

window.confirmArchiveProject = async function(projectName) {
  const title = "Archivar Proyecto";
  const message = `¿Deseas enviar el proyecto "${projectName}" a la papelera? Podrás restaurarlo más tarde si es necesario.`;
  
  showConfirmModal(title, message, async () => {
    try {
      await archiveProject(db, projectName);
      appState.needsResort = true; // Refresh frozen lists after move
    } catch (err) {
      console.error("Error archiving project:", err);
      alert("Hubo un error al archivar.");
    }
  });
};


/**
 * Custom confirmation modal to replace window.confirm
 */
function showConfirmModal(title, message, onConfirm) {
  const modalId = 'customConfirmModal';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'modal-overlay'; // Reuse existing modal style
    modal.innerHTML = `
      <div class="glass-card" style="max-width: 400px; width: 90%; padding: 2rem; border-top: 4px solid var(--status-alert);">
        <h3 id="confirmTitle" style="margin-top: 0; font-size: 1.25rem;">Confirmar</h3>
        <p id="confirmMessage" style="color: var(--text-muted); font-size: 0.95rem; line-height: 1.5; margin: 1.5rem 0;"></p>
        <div style="display: flex; justify-content: flex-end; gap: 1rem;">
          <button id="confirmCancelBtn" class="participant-btn" style="background:rgba(255,255,255,0.05); border:1px solid var(--card-border);">Cancelar</button>
          <button id="confirmOkBtn" class="delete-btn" style="background: var(--status-alert);">Confirmar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').innerText = message;
  
  const okBtn = document.getElementById('confirmOkBtn');
  const cancelBtn = document.getElementById('confirmCancelBtn');
  
  const close = () => modal.classList.remove('active');
  
  okBtn.onclick = () => { close(); onConfirm(); };
  cancelBtn.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  
  modal.classList.add('active');
}

window.confirmDeleteProjectPermanently = async function(projectName) {
  console.log("main.js: confirmDeleteProjectPermanently invocado para:", JSON.stringify(projectName));
  
  const title = "Eliminar de forma permanente";
  const message = `¿Estás completamente seguro de eliminar el proyecto "${projectName}"?\n\nEsta acción borrará todos los registros de la base de datos y NO se puede deshacer.`;
  
  showConfirmModal(title, message, async () => {
    console.log("main.js: Eliminación confirmada en modal.");
    try {
      showLoading();
      await deleteProjectPermanently(db, projectName);
      
      const safeId = projectName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      appState.expandedProjects.delete(safeId);
      appState.needsResort = true;
      render();
    } catch (err) {
      console.error("main.js: Error en borrado:", err);
      render();
      alert(`Error al eliminar: ${err.message}`);
    }
  });
};

window.confirmRestoreProject = async function(projectName) {
  const title = "Restaurar Proyecto";
  const message = `¿Deseas restaurar "${projectName}"? El proyecto dejará de estar en la papelera y volverá a ser un proyecto activo.`;
  
  showConfirmModal(title, message, async () => {
    try {
      await restoreProject(db, projectName);
      appState.needsResort = true; // Refresh frozen lists after move
    } catch (err) {
      console.error("Error restoring project:", err);
      alert("Hubo un error al restaurar.");
    }
  });
};

function setupEventListeners() {
  searchInput.addEventListener('input', (e) => {
    appState.searchQuery = e.target.value;
    renderProjects();
  });

  closeModalBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Delegación de eventos para botones de borrado y restauración
  document.addEventListener('click', (e) => {
    const permBtn = e.target.closest('.js-delete-permanent');
    if (permBtn) {
      window.confirmDeleteProjectPermanently(permBtn.dataset.project);
      return;
    }
    
    const restoreBtn = e.target.closest('.js-restore-project');
    if (restoreBtn) {
      window.confirmRestoreProject(restoreBtn.dataset.project);
      return;
    }

    const archiveBtn = e.target.closest('.js-archive-project');
    if (archiveBtn) {
      window.confirmArchiveProject(archiveBtn.dataset.project);
      return;
    }
  });

  editProgressRange.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    editProgressValue.textContent = `${val}%`;
    if (val === 100) {
      document.getElementById('editState').value = 'Finalizado';
    } else if (val > 0 && document.getElementById('editState').value === 'No iniciado') {
      document.getElementById('editState').value = 'En curso';
    } else if (val === 0) {
      document.getElementById('editState').value = 'No iniciado';
    }
  });

  const startDateInput = document.getElementById('editStartDate');
  const endDateInput = document.getElementById('editEndDate');

  // Initialize Flatpickr
  appState.fpStart = flatpickr("#editStartDate", {
    altInput: true,
    altFormat: "d/m/Y",
    dateFormat: "Y-m-d",
    disable: [
      (date) => (date.getDay() === 0 || date.getDay() === 6)
    ],
    onChange: (selectedDates, dateStr) => {
      appState.fpEnd.set('minDate', dateStr);
    }
  });

  appState.fpEnd = flatpickr("#editEndDate", {
    altInput: true,
    altFormat: "d/m/Y",
    dateFormat: "Y-m-d",
    disable: [
      (date) => (date.getDay() === 0 || date.getDay() === 6)
    ]
  });

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const phaseId = document.getElementById('editPhaseId').value;
    const newState = document.getElementById('editState').value;
    const newProgress = parseInt(editProgressRange.value, 10);
    const newComment = document.getElementById('editComment').value;
    const newStartDate = fromInputDate(startDateInput.value);
    const newEndDate = fromInputDate(endDateInput.value);

    // Validate start > end
    if (startDateInput.value && endDateInput.value && startDateInput.value > endDateInput.value) {
      document.getElementById('dateError').style.display = 'block';
      return;
    }
    document.getElementById('dateError').style.display = 'none';

    // Validate against project's delivery date
    const maxAllowed = startDateInput.max; // set from Entrega phase endDate
    const dateToCheck = endDateInput.value || startDateInput.value;
    if (maxAllowed && dateToCheck && dateToCheck > maxAllowed) {
      const deliveryErrorEl = document.getElementById('deliveryError');
      if (deliveryErrorEl) deliveryErrorEl.style.display = 'block';
      return;
    }
    const deliveryErrorEl = document.getElementById('deliveryError');
    if (deliveryErrorEl) deliveryErrorEl.style.display = 'none';

    const saveBtn = editForm.querySelector('button[type="submit"]');
    saveBtn.textContent = 'Guardando...';
    saveBtn.disabled = true;

    try {
      await updatePhase(db, phaseId, {
        state: newState,
        progress: newProgress,
        comment: newComment,
        startDate: newStartDate,
        endDate: newEndDate
      });
      closeModal();
    } catch (err) {
      console.error("Error updating phase:", err);
      saveBtn.textContent = 'Error, intenta de nuevo';
    } finally {
      saveBtn.textContent = 'Guardar Cambios';
      saveBtn.disabled = false;
    }
  });

  const addProjectBtn = document.getElementById('addProjectBtn');
  if (addProjectBtn) {
    addProjectBtn.addEventListener('click', () => {
      const modal = document.getElementById('newProjectModal');
      const errorMsg = document.getElementById('newProjectError');
      const nameInput = document.getElementById('newProjectNameInput');
      if (modal) {
        if (errorMsg) errorMsg.style.display = 'none';
        if (nameInput) nameInput.value = '';
        // Reset checkboxes
        document.querySelectorAll('input[name="projectPhase"]').forEach(cb => cb.checked = true);
        modal.classList.add('active');
        setTimeout(() => { if (nameInput) nameInput.focus(); }, 100);
      }
    });
  }

  // New Project Modal Listeners
  const closeNewProjectModal = () => {
    const modal = document.getElementById('newProjectModal');
    if (modal) modal.classList.remove('active');
  };
  document.getElementById('closeNewProjectModalBtn')?.addEventListener('click', closeNewProjectModal);
  document.getElementById('cancelNewProjectBtn')?.addEventListener('click', closeNewProjectModal);
  
  document.getElementById('newProjectForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorMsg = document.getElementById('newProjectError');
    if (errorMsg) errorMsg.style.display = 'none';

    // Get selected phases
    const selectedPhases = Array.from(document.querySelectorAll('input[name="projectPhase"]:checked')).map(cb => cb.value);
    
    if (selectedPhases.length === 0) {
      if (errorMsg) {
        errorMsg.textContent = 'Debes seleccionar al menos una fase.';
        errorMsg.style.display = 'block';
      }
      return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creando...';

    try {
      let projectName = document.getElementById('newProjectNameInput')?.value.trim();
      
      // Auto-generate name if empty
      if (!projectName) {
        const existingNames = new Set(appState.projects.map(p => p.name));
        projectName = 'Nuevo Proyecto';
        let counter = 2;
        while (existingNames.has(projectName)) {
          projectName = `Nuevo Proyecto ${counter++}`;
        }
      }

      await createNewProject(db, projectName, appState.selectedClient || 'General', selectedPhases);
      closeNewProjectModal();
    } catch (err) {
      console.error("Error creating project:", err);
      if (errorMsg) {
        errorMsg.textContent = 'Error al crear el proyecto.';
        errorMsg.style.display = 'block';
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  // Client Modal Listeners
  document.getElementById('closeClientModalBtn')?.addEventListener('click', closeClientModal);
  document.getElementById('cancelClientBtn')?.addEventListener('click', closeClientModal);
  document.getElementById('clientForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('newClientName');
    const name = nameInput.value.trim();
    if (!name) return;

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creando...';

    try {
      await addClient(db, name);
      appState.selectedClient = name;
      closeClientModal();
    } catch (err) {
      console.error("Error creating client:", err);
      alert("Error al guardar el cliente.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  const backupBtn = document.getElementById('backupBtn');
  if (backupBtn) {
    backupBtn.addEventListener('click', () => {
      const backupData = {
        clients: appState.clients,
        phases: appState.rawPhases,
        exportDate: new Date().toISOString()
      };
      
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", "respaldo_nexus_" + new Date().toISOString().split('T')[0] + ".json");
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    });
  }
}

window.openEditModal = function(phaseId) {
  const phase = appState.rawPhases.find(p => p.id === phaseId);
  if (!phase) return;

  document.getElementById('modalTitle').textContent = `${phase.project} — ${phase.phase}`;
  document.getElementById('editPhaseId').value = phase.id;
  document.getElementById('editState').value = phase.state;

  const progress = phase.progress || 0;
  editProgressRange.value = progress;
  editProgressValue.textContent = `${progress}%`;

  document.getElementById('editComment').value = phase.comment || '';
  document.getElementById('editStartDate').value = toInputDate(phase.startDate);
  document.getElementById('editEndDate').value = toInputDate(phase.endDate);

  // Update Flatpickr instances
  appState.fpStart.setDate(toInputDate(phase.startDate));
  appState.fpEnd.setDate(toInputDate(phase.endDate));

  // Set max date based on the project's Entrega end date
  // (only applies to phases that are NOT Entrega itself)
  const isEntrega = phase.phase === 'Entrega';
  const entregaPhase = isEntrega
    ? null
    : appState.rawPhases.find(p => p.project === phase.project && p.phase === 'Entrega');
  
  const maxDateVal = entregaPhase ? toInputDate(entregaPhase.endDate) : '';
  
  appState.fpStart.set('maxDate', maxDateVal);
  appState.fpEnd.set('maxDate', maxDateVal);
  
  // Set native max for consistency in submit handler validation
  const startDateInput = document.getElementById('editStartDate');
  const endDateInput = document.getElementById('editEndDate');
  startDateInput.max = maxDateVal;
  endDateInput.max = maxDateVal;
  
  // Also set minDate for end to the start
  appState.fpEnd.set('minDate', toInputDate(phase.startDate));

  // Update the delivery error text to show the limit date
  const deliveryErrorEl = document.getElementById('deliveryError');
  if (deliveryErrorEl && entregaPhase) {
    deliveryErrorEl.textContent = `⚠️ Las fechas no pueden superar la fecha de entrega del proyecto: ${entregaPhase.endDate}.`;
  }

  // Hide errors on open
  document.getElementById('dateError').style.display = 'none';
  if (deliveryErrorEl) deliveryErrorEl.style.display = 'none';

  modalOverlay.classList.add('active');
};

function closeModal() {
  modalOverlay.classList.remove('active');
}

// Phase card hover style (dynamic)
document.head.insertAdjacentHTML("beforeend", `
  <style>
    .phase-card:hover { border-color: rgba(99, 102, 241, 0.5) !important; box-shadow: 0 0 12px rgba(99, 102, 241, 0.15); }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: var(--accent-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
`);


// Start
init();
