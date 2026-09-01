import './style.css';
import { db, auth } from './firebase.js';
import {
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
  getUserRole,
  getUserProfile,
  subscribeToLogs,
  subscribeToUsers,
  saveUserProfile,
  deleteUserProfile
} from './data.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential
} from 'firebase/auth';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Application State
let appState = {
  rawPhases: [],
  projects: [],
  searchQuery: '',
  selectedParticipant: null,
  selectedStatuses: new Set(['En curso']),
  sortOrder: 'name_asc',
  needsResort: true,
  frozenActiveIds: null,
  frozenArchivedIds: null,
  unsubscribe: null,
  unsubscribeClients: null,
  unsubscribeUsers: null,
  unsubscribeLogs: null,
  selectedClient: null,
  clients: [],
  allUsers: [],
  fpStart: null,
  fpEnd: null,
  expandedProjects: new Set(),
  currentUser: null,
  currentUserRole: null,   // 'lector' | 'editor' | 'admin' | 'gerente'
  currentUserProfile: null, // full profile from Firestore
  logs: [],
  currentView: 'main',
  execSelectedClient: 'all',
  execHealthFilter: 'all',
  execSearchQuery: '',
  lastAiBriefingText: '',
  initialGanttScrollDone: false,
  returnScrollPos: null,
  ganttViewMode: 'weeks', // 'weeks' | 'months'
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function cleanupSubscriptions() {
  if (appState.unsubscribe) appState.unsubscribe();
  if (appState.unsubscribeClients) appState.unsubscribeClients();
  if (appState.unsubscribeUsers) appState.unsubscribeUsers();
  if (appState.unsubscribeLogs) appState.unsubscribeLogs();
  
  appState.unsubscribe = null;
  appState.unsubscribeClients = null;
  appState.unsubscribeUsers = null;
  appState.unsubscribeLogs = null;
}

// Initialize Application
async function init() {
  setupLoginScreen();
  showLoading();

  setupEventListeners();
  setupAuthListeners();
  setupExecutiveEventListeners();

  // Watch auth state
  onAuthStateChanged(auth, async (user) => {
    appState.currentUser = user;
    if (user) {
      appState.currentUserRole = await getUserRole(db, user.uid);
      appState.currentUserProfile = await getUserProfile(db, user.uid);
      
      cleanupSubscriptions();

      // Subscribe to real-time updates: PHASES
      appState.unsubscribe = subscribeToPhases(db, (phases) => {
        appState.rawPhases = phases;
        appState.projects = aggregateProjectData(phases);
        render();
      });

      // Subscribe to real-time updates: CLIENTS
      appState.unsubscribeClients = subscribeToClients(db, (clients) => {
        appState.clients = clients;
        if (!appState.selectedClient && clients.length > 0) {
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

      // Subscribe to users (for admin panel)
      appState.unsubscribeUsers = subscribeToUsers(db, (users) => {
        appState.allUsers = users;
      });

      // Subscribe to real-time updates: LOGS
      appState.unsubscribeLogs = subscribeToLogs(db, (logs) => {
        appState.logs = logs;
        if (appState.currentView === 'logs') renderLogs();
      });

      // Role based view navigation: Gerentes / Jefaturas default to executive view
      if (appState.currentUserRole === 'gerente') {
        window.switchAppView('executive');
      } else if (window.location.hash === '#executive') {
        window.switchAppView('executive');
      } else if (window.location.hash === '#logs') {
        window.switchAppView('logs');
      } else {
        window.switchAppView('main');
      }

    } else {
      appState.currentUserRole = null;
      appState.currentUserProfile = null;
      cleanupSubscriptions();
      appState.rawPhases = [];
      appState.projects = [];
      appState.clients = [];
      appState.allUsers = [];
      appState.logs = [];
    }
    
    applyAuthUI(user);
    applyRoleRestrictions();
    render();
    setupScrollEffects();
  });

  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#executive') {
      // Only gerente and admin can access the executive view
      if (appState.currentUserRole === 'gerente' || appState.currentUserRole === 'admin') {
        window.switchAppView('executive');
      } else {
        window.location.hash = '';
        window.switchAppView('main');
      }
    } else if (window.location.hash === '#logs') {
      window.switchAppView('logs');
    } else {
      window.switchAppView('main');
    }
  });
}

// ─── Auth UI ────────────────────────────────────────────────────────────────
function applyAuthUI(user) {
  const loginScreen   = document.getElementById('loginScreen');
  const userInfo      = document.getElementById('userInfo');
  const userEmail     = document.getElementById('userEmail');
  const userAvatar    = document.getElementById('userAvatar');
  const addProjectBtn = document.getElementById('addProjectBtn');
  const backupBtn     = document.getElementById('backupBtn');
  const showLogsBtn   = document.getElementById('showLogsBtn');
  const manageUsersBtn = document.getElementById('manageUsersBtn');

  if (user) {
    // Hide full-page login screen
    if (loginScreen) {
      loginScreen.style.opacity = '0';
      loginScreen.style.transition = 'opacity 0.4s ease';
      setTimeout(() => { loginScreen.style.display = 'none'; }, 400);
    }
    if (userInfo) userInfo.style.display = 'flex';
    const displayName = appState.currentUserProfile?.displayName || user.email;
    if (userEmail) userEmail.textContent = displayName;
    if (userAvatar) userAvatar.textContent = (displayName[0] || '?').toUpperCase();

    const role = appState.currentUserRole;
    // Editor & Admin can add projects and backup
    if (addProjectBtn) addProjectBtn.style.display = (role === 'editor' || role === 'admin') ? '' : 'none';
    if (backupBtn) backupBtn.style.display = (role === 'editor' || role === 'admin') ? 'flex' : 'none';
    // Logs: editor + admin
    if (showLogsBtn) showLogsBtn.style.display = (role === 'editor' || role === 'admin') ? 'flex' : 'none';
    // Manage users: admin only
    if (manageUsersBtn) manageUsersBtn.style.display = role === 'admin' ? 'flex' : 'none';
    // View mode selector: only gerente and admin can switch to executive view
    const viewModeSelector = document.getElementById('viewModeSelector');
    if (viewModeSelector) viewModeSelector.style.display = (role === 'gerente' || role === 'admin') ? 'inline-flex' : 'none';
  } else {
    // Show full-page login screen
    if (loginScreen) { loginScreen.style.display = 'flex'; loginScreen.style.opacity = '1'; }
    if (userInfo) userInfo.style.display = 'none';
    if (addProjectBtn) addProjectBtn.style.display = 'none';
    if (backupBtn) backupBtn.style.display = 'none';
    if (showLogsBtn) showLogsBtn.style.display = 'none';
    if (manageUsersBtn) manageUsersBtn.style.display = 'none';
    if (appState.currentView === 'logs') window.showMainView();
  }
}

// Apply data restrictions based on role (lector: filter by allowedClients)
function applyRoleRestrictions() {
  if (appState.currentUserRole === 'lector') {
    const allowed = appState.currentUserProfile?.allowedClients || [];
    // If the currently selected client is not in allowedClients, switch
    if (allowed.length > 0 && !allowed.includes(appState.selectedClient)) {
      appState.selectedClient = allowed[0];
    }
  }
}

// ─── Scroll Effects ──────────────────────────────────────────────────────────
function setupScrollEffects() {
  const tabs = document.getElementById('clientTabs');
  if (!tabs) return;

  let lastScrollY = window.scrollY;
  const threshold = 80; // No esconder inmediatamente en el tope

  window.addEventListener('scroll', () => {
    const currentScrollY = window.scrollY;
    
    // Si bajamos y pasamos el umbral, escondemos
    if (currentScrollY > lastScrollY && currentScrollY > threshold) {
      tabs.classList.add('hidden');
    } 
    // Si subimos, mostramos
    else {
      tabs.classList.remove('hidden');
    }
    
    lastScrollY = currentScrollY;
  }, { passive: true });
}

// ─── Full-page Login Screen ──────────────────────────────────────────────────
function setupLoginScreen() {
  const form    = document.getElementById('loginScreenForm');
  const errEl   = document.getElementById('loginScreenError');
  const submitBtn = document.getElementById('loginScreenSubmitBtn');
  const toggleBtn = document.getElementById('loginScreenTogglePwd');
  const pwdInput  = document.getElementById('loginScreenPassword');

  toggleBtn?.addEventListener('click', () => {
    pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password';
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('loginScreenEmail').value.trim();
    const password = pwdInput.value;
    if (!email || !password) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verificando...';
    if (errEl) errEl.style.display = 'none';

    try {
      await signInWithEmailAndPassword(auth, email, password);
      // applyAuthUI will hide the screen on auth state change
    } catch (err) {
      let msg = 'Error al iniciar sesión. Intenta de nuevo.';
      if (['auth/user-not-found','auth/wrong-password','auth/invalid-credential'].includes(err.code)) {
        msg = 'Correo o contraseña incorrectos.';
      } else if (err.code === 'auth/too-many-requests') {
        msg = 'Demasiados intentos fallidos. Espera unos minutos.';
      } else if (err.code === 'auth/invalid-email') {
        msg = 'El formato del correo no es válido.';
      }
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Iniciar sesión';
    }
  });
}

function setupAuthListeners() {
  // Logout
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await signOut(auth);
  });

  // Open user management modal (admin only)
  document.getElementById('manageUsersBtn')?.addEventListener('click', () => {
    openUserMgmtModal();
  });
  document.getElementById('closeUserMgmtBtn')?.addEventListener('click', closeUserMgmtModal);
  document.getElementById('userMgmtModal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('userMgmtModal')) closeUserMgmtModal();
  });

  document.getElementById('saveUserBtn')?.addEventListener('click', saveUser);
  document.getElementById('cancelUserFormBtn')?.addEventListener('click', resetUserForm);

  // Return to Gantt logic
  document.getElementById('returnToGanttBtn')?.addEventListener('click', () => {
    if (appState.returnScrollPos !== null) {
      window.scrollTo({ top: appState.returnScrollPos, behavior: 'smooth' });
      appState.returnScrollPos = null;
      
      const btn = document.getElementById('returnToGanttBtn');
      if (btn) {
        btn.style.transform = 'translateX(-50%) translateY(-100px)';
        btn.style.opacity = '0';
        btn.style.pointerEvents = 'none';
      }
    }
  });

  // Settings Modal
  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    openSettingsModal();
  });
  document.getElementById('closeSettingsBtn')?.addEventListener('click', closeSettingsModal);
  document.getElementById('settingsModal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('settingsModal')) closeSettingsModal();
  });

  document.getElementById('settingsForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = document.getElementById('geminiApiKey').value.trim();
    localStorage.setItem('gemini_api_key', key);
    alert('Configuración guardada correctamente.');
    closeSettingsModal();
  });

  document.getElementById('changePasswordForm')?.addEventListener('submit', handlePasswordChange);
}

function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const apiKeyInput = document.getElementById('geminiApiKey');
  const pwdForm = document.getElementById('changePasswordForm');
  
  if (apiKeyInput) apiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
  if (pwdForm) pwdForm.reset();
  
  const err = document.getElementById('passwordError');
  const success = document.getElementById('passwordSuccess');
  if (err) err.style.display = 'none';
  if (success) success.style.display = 'none';
  
  if (modal) modal.classList.add('active');
}

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.remove('active');
}

async function handlePasswordChange(e) {
  e.preventDefault();
  const currentPwd = document.getElementById('currentPassword').value;
  const newPwd = document.getElementById('newPassword').value;
  const confirmPwd = document.getElementById('confirmNewPassword').value;
  const errEl = document.getElementById('passwordError');
  const successEl = document.getElementById('passwordSuccess');
  const submitBtn = document.getElementById('changePasswordBtn');

  if (errEl) errEl.style.display = 'none';
  if (successEl) successEl.style.display = 'none';

  if (newPwd !== confirmPwd) {
    if (errEl) { errEl.textContent = 'Las contraseñas no coinciden.'; errEl.style.display = 'block'; }
    return;
  }

  if (newPwd.length < 6) {
    if (errEl) { errEl.textContent = 'La nueva contraseña debe tener al menos 6 caracteres.'; errEl.style.display = 'block'; }
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Procesando...';

  try {
    const user = auth.currentUser;
    if (!user) throw new Error('No hay una sesión activa.');

    // Re-authenticate user
    const credential = EmailAuthProvider.credential(user.email, currentPwd);
    await reauthenticateWithCredential(user, credential);

    // Update password
    await updatePassword(user, newPwd);

    if (successEl) { 
      successEl.textContent = '¡Contraseña actualizada! Se ha cerrado la sesión en otros dispositivos.'; 
      successEl.style.display = 'block'; 
    }
    e.target.reset();
    
    // Optional: alert and close
    setTimeout(() => {
      closeSettingsModal();
    }, 2000);

  } catch (err) {
    console.error("Error changing password:", err);
    let msg = 'Error al cambiar la contraseña.';
    if (err.code === 'auth/wrong-password') msg = 'La contraseña actual es incorrecta.';
    else if (err.code === 'auth/weak-password') msg = 'La contraseña es muy débil.';
    else if (err.code === 'auth/requires-recent-login') msg = 'Por seguridad, vuelve a iniciar sesión antes de realizar este cambio.';
    
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Actualizar y Cerrar Otros Dispositivos';
  }
}

// Render the UI
function render() {
  if (appState.currentView === 'executive') {
    renderExecutiveView();
    return;
  }
  if (appState.currentView === 'logs') {
    renderLogs();
    return;
  }
  renderClientTabs();
  renderGantt();
  renderStatusFilters();
  renderDashboard();
  renderWorkloadHeatmap();
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
const GANTT_COLORS = ['#2563eb', '#00d2ff', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4'];
const PHASE_COLORS = { 'Levantamiento':'#2563eb', 'Desarrollo':'#00d2ff', 'Testing/QA':'#f59e0b', 'Entrega':'#10b981' };

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

function monthStart(date) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function monthLabel(date) {
  const m = MONTH_LABELS[date.getMonth()];
  const y = date.getFullYear();
  // Mostrar año solo si es Enero o si es el primer mes de la línea de tiempo
  return `${m} '${String(y).substring(2)}`;
}

function getMonthsForPhases(phases) {
  let allDates = [];
  phases.forEach(p => {
    const s = parseDate(p.startDate);
    const e = parseDate(p.endDate);
    if (s) allDates.push(s);
    if (e) allDates.push(e);
  });
  if (allDates.length === 0) return [];
  const minDate = monthStart(new Date(Math.min(...allDates)));
  const maxDate = new Date(Math.max(...allDates));
  const months = [];
  const cursor = new Date(minDate);
  while (cursor <= maxDate) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  months.push(new Date(cursor)); // buffer
  return months;
}

function getGlobalTimeline() {
  if (appState.ganttViewMode === 'months') {
    return getMonthsForPhases(appState.rawPhases);
  }
  return getGlobalWeeks();
}

window.setGanttViewMode = function(mode) {
  appState.ganttViewMode = mode;
  appState.initialGanttScrollDone = false;
  render();
};

function getGlobalWeeks() {
  return getWeeksForPhases(appState.rawPhases);
}

// ─── Gantt Chart ───────────────────────────────────────────────────────────
// ─── Client Tabs ───────────────────────────────────────────────────────────
function renderClientTabs() {
  const container = document.getElementById('clientTabs');
  if (!container) return;

  let clients = appState.clients;

  // Lector: only show allowed clients
  if (appState.currentUserRole === 'lector') {
    const allowed = appState.currentUserProfile?.allowedClients || [];
    clients = clients.filter(c => allowed.includes(c.name));
  }

  if (clients.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  const canEdit = appState.currentUserRole === 'editor' || appState.currentUserRole === 'admin';

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

  // Guardar posición actual para poder volver
  appState.returnScrollPos = window.scrollY;
  const returnBtn = document.getElementById('returnToGanttBtn');
  if (returnBtn) {
    returnBtn.style.transform = 'translateX(-50%) translateY(0)';
    returnBtn.style.opacity = '1';
    returnBtn.style.pointerEvents = 'all';
  }

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
  const isMonths = appState.ganttViewMode === 'months';
  
  // Find which bucket today falls into
  const weekIdx = weeks.findIndex((w, i) => {
    const wStart = w;
    const wEnd   = weeks[i + 1] ?? (isMonths ? new Date(w.getFullYear(), w.getMonth() + 1, 1) : new Date(w.getTime() + 7 * 86400000));
    
    const todayNum  = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const startNum  = wStart.getFullYear() * 10000 + (wStart.getMonth() + 1) * 100 + wStart.getDate();
    const endD      = new Date(wEnd.getTime() - 1);
    const endNum    = endD.getFullYear() * 10000 + (endD.getMonth() + 1) * 100 + endD.getDate();
    return todayNum >= startNum && todayNum <= endNum;
  });

  if (weekIdx === -1) return null;

  const totalW = labelW + weeks.length * colW;
  
  if (isMonths) {
    const startOfMonth = monthStart(now);
    const nextMonth    = new Date(startOfMonth);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const totalDays    = getWorkingDaysBetween(startOfMonth, new Date(nextMonth.getTime() - 86400000));
    const currentDays  = getWorkingDaysBetween(startOfMonth, now);
    const fraction     = currentDays / totalDays;
    
    const currentX = labelW + (weekIdx * colW) + (fraction * colW);
    return (currentX / totalW) * 100 + '%';
  } else {
    const dow = now.getDay();
    let fraction;
    if      (dow === 0) fraction = 0;
    else if (dow === 6) fraction = 1;
    else                fraction = (dow - 1) / 5;

    const currentX = labelW + (weekIdx * colW) + (fraction * colW);
    return (currentX / totalW) * 100 + '%';
  }
}

function renderGantt() {
  const ganttEl = document.getElementById('ganttChart');
  const activeProjects = appState.projects.filter(p => !p.isArchived && 
    p.client === appState.selectedClient &&
    (appState.selectedStatuses.size === 0 || appState.selectedStatuses.has(p.status))
  );
  
  if (!ganttEl || appState.rawPhases.length === 0) return;

  const timeline = getGlobalTimeline();
  if (timeline.length === 0) { ganttEl.innerHTML = ''; return; }
  
  const isMonths = appState.ganttViewMode === 'months';
  const totalCols = timeline.length;
  const ROW_H = 52, COL_W = isMonths ? 100 : 80, LABEL_W = 240;

  const headerCells = timeline.map(d =>
    `<th style="min-width:${COL_W}px; padding: 0.6rem 0 0.6rem 6px; font-size:0.72rem; font-weight:600; color:var(--text-muted); text-align:left; background:rgba(0,0,0,0.25); border-left:1px solid var(--card-border); white-space:nowrap;">${isMonths ? monthLabel(d) : weekLabel(d)}</th>`
  ).join('');

  const rowsHtml = activeProjects.map((proj, i) => {
    const phaseDates = proj.phases.flatMap(ph => [parseDate(ph.startDate), parseDate(ph.endDate)]).filter(Boolean);
    if (phaseDates.length === 0) return '';
    
    const minPhaseDate = new Date(Math.min(...phaseDates));
    const maxPhaseDate = new Date(Math.max(...phaseDates));
    
    const startBucket = isMonths ? monthStart(minPhaseDate) : weekStart(minPhaseDate);
    const endBucket   = isMonths ? monthStart(maxPhaseDate) : weekStart(maxPhaseDate);
    
    const startCol  = timeline.findIndex(d => d.getTime() === startBucket.getTime());
    let   endCol    = timeline.findIndex(d => d.getTime() === endBucket.getTime());
    if (endCol === -1) endCol = totalCols - 1;
    const span  = Math.max(1, endCol - startCol + 1);
    
    // Precise visual offset and width calculation (WORKING DAYS ONLY)
    const nextBucketDate = timeline[endCol + 1] || (isMonths ? addDays(endBucket, 32) : addDays(endBucket, 7));
    const spanEndDate = new Date(nextBucketDate.getTime() - 86400000);
    const totalSpanWorkingDays = getWorkingDaysBetween(startBucket, spanEndDate);
    
    let offsetDays = 0;
    if (minPhaseDate > startBucket) {
      offsetDays = Math.max(0, getWorkingDaysBetween(startBucket, minPhaseDate) - 1);
    }
    
    const durationDays = Math.max(1, getWorkingDaysBetween(minPhaseDate, maxPhaseDate));
    
    let offsetPercent = (offsetDays / totalSpanWorkingDays) * 100;
    let widthPercent = (durationDays / totalSpanWorkingDays) * 100;
    if (widthPercent + offsetPercent > 100) widthPercent = 100 - offsetPercent;
    
    let color = '#4b5563'; // Opaco para No iniciado
    if (proj.status === 'En curso') {
      color = '#10b981'; // Verde
    } else if (proj.status === 'Finalizado' || proj.status === 'Completado') {
      color = '#3b82f6'; // Azul
    }

    const cells = timeline.map((_, ci) => {
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
          
          return `<div style="position:absolute; left:${leftPct}%; width:${wPct}%; height:100%; background:${color}; z-index:1; border-radius:6px;"></div>`;
        }).join('');

        const responsibleInitials = (proj.responsible || '?').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        
        return `<td colspan="${span}" style="padding:0.5rem 4px; border-left:1px solid rgba(255,255,255,0.04);">
          <div style="position:relative; background:${color}33; border-radius:6px; height:30px; display:flex; align-items:center; overflow:visible; box-shadow:0 2px 8px ${color}66; margin-left:${offsetPercent}%; width:${widthPercent}%;">
            ${phasesHtml}
            <div style="position:relative; z-index:2; padding:0 1rem; font-size:0.72rem; font-weight:600; color:white; white-space:nowrap;">${proj.overallProgress}%</div>
            
            <div style="position:absolute; right:-10px; top:-12px; width:26px; height:26px; border-radius:50%; background:${color}; display:flex; align-items:center; justify-content:center; font-size:0.65rem; font-weight:bold; color:white; z-index:4; border:2px solid var(--bg-color); box-shadow:0 4px 10px rgba(0,0,0,0.4);" title="${proj.responsible || 'Sin asignar'}">
              ${responsibleInitials}
            </div>
          </div>
        </td>`;
      }
      if (ci > startCol && ci < startCol + span) return '';
      return `<td style="border-left:1px solid rgba(255,255,255,0.04);"></td>`;
    }).join('');

    const ganttSafeId = proj.id.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    return `<tr style="height:${ROW_H}px;">
      <td 
        onclick="window.scrollToProject('${ganttSafeId}')"
        onmouseenter="window.handleGanttHover(event, '${proj.id}')"
        onmouseleave="window.handleGanttLeave(event)"
        style="min-width:${LABEL_W}px; max-width:${LABEL_W}px; padding:0 1.25rem; font-size:0.85rem; font-weight:600; background: color-mix(in srgb, ${color} 10%, #071536); border-right:2px solid ${color}; position:sticky; left:0; z-index:5; overflow:visible; white-space:normal; line-height:1.3; box-shadow: 8px 0 12px -8px rgba(0,0,0,0.5); cursor:pointer; transition: background 0.2s;"
      >
        <span style="display:block; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); color:var(--text-main); pointer-events:none;">
          ${proj.name}
        </span>
      </td>
      ${cells}</tr>`;
  }).join('');

  const todayX = getTodayX(timeline, LABEL_W, COL_W);
  const todayLine = todayX !== null ? `<div class="today-line" style="left:${todayX}; height: 100%;"></div>` : '';

  const totalW = LABEL_W + totalCols * COL_W;
  
  ganttEl.style.position = ''; // Remove relative from scroll container to prevent absolute element from breaking
  ganttEl.innerHTML = `
    <div style="position:relative; width:100%; min-width:${totalW}px;">
      ${todayLine}
      <table style="border-collapse:collapse; width:100%; table-layout:fixed;">
      <colgroup><col style="width:${LABEL_W}px;">${timeline.map(() => `<col style="width:${COL_W}px;">`).join('')}</colgroup>
    <thead><tr>
      <th style="position:sticky; left:0; z-index:6; background:#061330; min-width:${LABEL_W}px; padding:0.8rem 1.25rem; font-size:0.75rem; font-weight:700; color:#38bdf8; text-align:left; border-right:1px solid rgba(56, 189, 248, 0.2); border-bottom:1px solid rgba(56, 189, 248, 0.2); text-transform:uppercase; letter-spacing:0.05em; box-shadow: 8px 0 12px -8px rgba(0,0,0,0.5);">Proyecto</th>
      ${headerCells}
    </tr></thead>
    <tbody style="background:rgba(0,0,0,0.1);">${rowsHtml}</tbody>
  </table>
  </div>`;

  // Update toggle buttons in index.html if they exist
  const weeksBtn = document.getElementById('viewWeeksBtn');
  const monthsBtn = document.getElementById('viewMonthsBtn');
  if (weeksBtn && monthsBtn) {
    weeksBtn.classList.toggle('active', !isMonths);
    monthsBtn.classList.toggle('active', isMonths);
  }

  // Center on today on initial load or view change
  if (todayX !== null && !appState.initialGanttScrollDone) {
    appState.initialGanttScrollDone = true;
    requestAnimationFrame(() => {
      const todayLineEl = ganttEl.querySelector('.today-line');
      if (todayLineEl) {
        const todayPos = todayLineEl.offsetLeft;
        const containerWidth = ganttEl.clientWidth;
        ganttEl.scrollLeft = todayPos - containerWidth / 2;
      }
    });
  }
}

// ─── Per-Project Mini Gantt ────────────────────────────────────────────────
function buildPhaseGanttTable(proj, timeline, projColor) {
  if (!timeline || timeline.length === 0) return '<p style="padding:1rem; color:var(--text-muted); font-size:0.8rem;">Sin datos de semanas.</p>';
  const totalCols = timeline.length;
  const isMonths = appState.ganttViewMode === 'months';
  const COL_W = isMonths ? 100 : 80, LABEL_W = 200;

  const headerCells = timeline.map(d =>
    `<th style="min-width:${COL_W}px; padding:0.5rem 0 0.5rem 6px; font-size:0.7rem; font-weight:600; color:var(--text-muted); text-align:left; background:rgba(0,0,0,0.3); border-left:1px solid var(--card-border); white-space:nowrap;">${isMonths ? monthLabel(d) : weekLabel(d)}</th>`
  ).join('');

  const rowsHtml = proj.phases.map(phase => {
    const s = parseDate(phase.startDate);
    const e = parseDate(phase.endDate);
    if (!s || !e) return '';
    const startBucket = isMonths ? monthStart(s) : weekStart(s);
    const endBucket   = isMonths ? monthStart(e) : weekStart(e);
    const startCol  = timeline.findIndex(d => d.getTime() === startBucket.getTime());
    let   endCol    = timeline.findIndex(d => d.getTime() === endBucket.getTime());
    if (endCol === -1) endCol = totalCols - 1;
    if (startCol === -1) return '';
    const span  = Math.max(1, endCol - startCol + 1);
    const color = PHASE_COLORS[phase.phase] || projColor;

    // Precise visual offset and width calculation (WORKING DAYS ONLY)
    const nextBucketDate = timeline[endCol + 1] || (isMonths ? addDays(endBucket, 32) : addDays(endBucket, 7));
    const spanEndDate = new Date(nextBucketDate.getTime() - 86400000);
    const totalSpanWorkingDays = getWorkingDaysBetween(startBucket, spanEndDate);

    let offsetDays = 0;
    if (s > startBucket) {
      offsetDays = Math.max(0, getWorkingDaysBetween(startBucket, s) - 1);
    }
    
    const durationDays = Math.max(1, getWorkingDaysBetween(s, e));
    
    let offsetPercent = (offsetDays / totalSpanWorkingDays) * 100;
    let widthPercent = (durationDays / totalSpanWorkingDays) * 100;
    if (widthPercent + offsetPercent > 100) widthPercent = 100 - offsetPercent;

    const cells = timeline.map((_, ci) => {
      if (ci === startCol) return `<td colspan="${span}" style="padding:0.4rem 4px; border-left:1px solid rgba(255,255,255,0.04);">
        <div style="position:relative; height:26px; margin-left:${offsetPercent}%; width:${widthPercent}%;">
          <div title="${phase.startDate} – ${phase.endDate}" 
               style="background:${color}; opacity:0.9; border-radius:6px; height:100%; display:flex; align-items:center; justify-content:space-between; padding:0 0.75rem; font-size:0.68rem; font-weight:600; color:white; white-space:nowrap; overflow:hidden; box-shadow:0 2px 6px ${color}55;">
            <span style="overflow:hidden; text-overflow:ellipsis;">${phase.phase}</span>
            <span style="margin-left:0.5rem; opacity:0.85;">${phase.progress || 0}%</span>
          </div>
        </div></td>`;
      if (ci > startCol && ci < startCol + span) return '';
      return `<td style="border-left:1px solid rgba(255,255,255,0.04);"></td>`;
    }).join('');

    return `<tr style="height:44px;">
      <td style="min-width:${LABEL_W}px; max-width:${LABEL_W}px; padding:0 0.75rem; font-size:0.75rem; font-weight:600; color:var(--text-main); background: color-mix(in srgb, ${color} 10%, #0a0c14); border-right:2px solid ${color}88; position:sticky; left:0; z-index:2; overflow:visible; white-space:normal; line-height:1.2; box-shadow: 6px 0 10px -6px rgba(0,0,0,0.5);">${phase.phase}</td>
      ${cells}</tr>`;
  }).join('');

  const todayX = getTodayX(timeline, LABEL_W, COL_W);
  const todayLine = todayX !== null ? `<div class="today-line" style="left:${todayX}; height: 100%;"></div>` : '';

  const totalW = LABEL_W + totalCols * COL_W;
  return `
    <div style="position:relative; width:100%; min-width:${totalW}px;">
      ${todayLine}
      <table style="border-collapse:collapse; width:100%; table-layout:fixed;">
        <colgroup><col style="width:${LABEL_W}px;">${timeline.map(() => `<col style="width:${COL_W}px;">`).join('')}</colgroup>
        <thead><tr>
          <th style="position:sticky; left:0; z-index:3; background:rgba(10,12,20,0.98); min-width:${LABEL_W}px; padding:0.5rem 0.75rem; font-size:0.7rem; font-weight:600; color:var(--text-muted); text-align:left;">Fase</th>
          ${headerCells}
        </tr></thead>
        <tbody style="background:rgba(0,0,0,0.15);">${rowsHtml}</tbody>
      </table>
    </div>`;
}



// ─── Workload Heatmap ───────────────────────────────────────────────────────
function renderWorkloadHeatmap() {
  const container = document.getElementById('workloadHeatmap');
  const section = document.getElementById('workloadSection');
  if (!container || !section) return;

  const activeProjects = appState.projects.filter(p => !p.isArchived && p.client === appState.selectedClient && p.status !== 'Completado' && p.status !== 'Finalizado');
  
  if (activeProjects.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  // Count active projects per person
  const loadMap = {};
  activeProjects.forEach(proj => {
    const person = proj.responsible || 'Sin asignar';
    if (!loadMap[person]) {
      loadMap[person] = { count: 0, projects: [] };
    }
    loadMap[person].count += 1;
    loadMap[person].projects.push(proj.name);
  });

  // Sort by load (descending)
  const sortedLoad = Object.entries(loadMap).sort((a, b) => b[1].count - a[1].count);

  const cardsHtml = sortedLoad.map(([person, data]) => {
    // Determine color based on workload
    let color = 'var(--status-done)'; // Green
    let statusText = 'Carga óptima';
    if (data.count >= 5) {
      color = 'var(--status-alert)'; // Red
      statusText = 'Sobrecarga';
    } else if (data.count >= 3) {
      color = 'var(--status-in-progress)'; // Orange/Yellow
      statusText = 'Carga media';
    }

    const initials = person.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    const tooltipText = data.projects.join('&#10;');

    return `
      <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 1rem; display: flex; align-items: center; gap: 1rem; position: relative; overflow: hidden; transition: transform 0.2s;" title="${tooltipText}">
        <div style="position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: ${color};"></div>
        <div style="width: 40px; height: 40px; border-radius: 50%; background: color-mix(in srgb, ${color} 20%, transparent); border: 1px solid ${color}; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.9rem; color: ${color}; flex-shrink: 0;">
          ${initials}
        </div>
        <div style="flex: 1; min-width: 0;">
          <h4 style="margin: 0; font-size: 0.95rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${person}">${person}</h4>
          <p style="margin: 0; font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.3rem;">
            <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${color};"></span>
            ${statusText}
          </p>
        </div>
        <div style="font-size: 1.5rem; font-weight: 700; color: white;">
          ${data.count}
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = cardsHtml;
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
    const matchesStatus = appState.selectedStatuses.size === 0 || appState.selectedStatuses.has(p.status);
    return matchesSearch && matchesParticipant && matchesStatus;
  });

  renderParticipantFilters();
  renderStatusFilters();

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
    
    appState.frozenActiveIds = sortedActive.map(p => p.id);
    appState.frozenArchivedIds = sortedArchived.map(p => p.id);
    appState.needsResort = false;
    console.log(`main.js: Orden congelado para ${appState.frozenActiveIds.length} proyectos activos.`);
  }

  // Use the frozen order to sort the current (filtered) projects
  const applyFrozenOrder = (list, frozenIds) => {
    return list.sort((a, b) => {
      let idxA = frozenIds.indexOf(a.id);
      let idxB = frozenIds.indexOf(b.id);
      
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
    // Lectores no ven la papelera
    if (appState.currentUserRole === 'lector') {
      papeleraSection.style.display = 'none';
    } else if (archivedProjects.length > 0) {
      papeleraSection.style.display = 'block';
      archivedProjectsListEl.innerHTML = archivedProjects.map((proj, index) => renderProjectCard(proj, index, true)).join('');
    } else {
      papeleraSection.style.display = 'none';
      archivedProjectsListEl.innerHTML = '';
    }
  }
}

function renderProjectCard(proj, index, isArchived) {
  const globalIndex = appState.projects.findIndex(p => p.id === proj.id);
  const projColor = GANTT_COLORS[globalIndex % GANTT_COLORS.length];
  const safeId = proj.id.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const isExpanded = appState.expandedProjects.has(safeId);
  const role = appState.currentUserRole;
  const canEdit = role === 'editor' || role === 'admin';
  const canDelete = role === 'admin';

  // Format health badge
  let healthBadge = `<span class="exec-pill exec-pill-green">🟢 ${proj.healthLabel || 'A Tiempo'}</span>`;
  if (proj.health === 'at_risk') healthBadge = `<span class="exec-pill exec-pill-yellow">🟡 ${proj.healthLabel || 'En Riesgo'}</span>`;
  if (proj.health === 'delayed') healthBadge = `<span class="exec-pill exec-pill-coral">🚨 ${proj.healthLabel || 'Retrasado'}</span>`;
  if (proj.health === 'completed') healthBadge = `<span class="exec-pill exec-pill-blue">✅ ${proj.healthLabel || 'Completado'}</span>`;

  // Get all comments text
  const rawComments = (proj.phases.map(p => p.comment).filter(Boolean).join('\n') || proj.comment || proj.comments || '').trim();
  const commentLines = rawComments ? rawComments.split('\n').filter(Boolean) : [];

  const mainPhaseId = (proj.phases[0] && proj.phases[0].id) || proj.id;

  return `
  <div id="project-card-${safeId}" class="glass-card animate-fade-in ${isArchived ? 'archived-project' : ''}" style="animation-delay: ${0.07 * (index % 6)}s; margin-bottom: 1.5rem; padding: 1.5rem;">
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; flex-wrap: wrap; gap: 1rem;">
      <div style="flex: 1; min-width: 280px;">
        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.4rem; flex-wrap: wrap;">
          <h3 ${canEdit && !isArchived ? `class="editable-field" contenteditable="true" onblur="window.handleMetaBlur(this, '${proj.id}', 'name')"` : ''}
              onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}"
              style="font-size: 1.3rem; font-weight: 700; margin-bottom: 0; min-width: 100px; color: #f8fafc;">${proj.name}</h3>
          
          <span class="exec-pill exec-pill-purple" style="font-size: 0.75rem; font-weight: 600;">
            🎯 Etapa IA: ${proj.inferredPhase || 'Levantamiento'}
          </span>
          ${healthBadge}
        </div>

        <div style="display: flex; align-items: center; gap: 1.25rem; color: var(--text-muted); font-size: 0.85rem; flex-wrap: wrap; margin-top: 0.35rem;">
          <div style="display: flex; align-items: center; gap: 0.4rem;">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
            <span ${canEdit && !isArchived ? `class="editable-field" contenteditable="true" onblur="window.handleMetaBlur(this, '${proj.id}', 'responsible')"` : ''}
                  onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}"
                  style="min-width: 80px; color: #cbd5e1;">${proj.responsible || 'Sin asignar'}</span>
          </div>

          <div style="display: flex; align-items: center; gap: 0.4rem;">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path></svg>
            ${canEdit && !isArchived ? `
              <select class="editable-field" style="background: transparent; border: none; color: #cbd5e1; cursor: pointer; padding: 0; outline: none;" onchange="window.handleClientChange('${proj.id}', this.value)">
                ${appState.clients.map(c => `<option value="${c.name}" ${c.name === proj.client ? 'selected' : ''} style="background: var(--bg-color); color: var(--text-main);">${c.name}</option>`).join('')}
              </select>
            ` : `
              <span style="color: #cbd5e1;">${proj.client || 'General'}</span>
            `}
          </div>

          <div style="display: flex; align-items: center; gap: 0.4rem; color: #38bdf8;">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span>${proj.startDate || '—'} → ${proj.deliveryDate || '—'}</span>
          </div>
        </div>
      </div>

      <!-- Actions & Global Time Progress -->
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          ${canEdit && !isArchived ? `
            <button class="primary" style="font-size: 0.78rem; padding: 0.35rem 0.8rem; display: flex; align-items: center; gap: 0.4rem;" onclick="window.openEditModal('${mainPhaseId}')">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
              Editar Fechas / Estado
            </button>
          ` : ''}

          ${canEdit ? (!isArchived ? `
            <button class="archive-btn js-archive-project" data-project-id="${proj.id}" data-project-name="${proj.name}" title="Archivar Proyecto" style="font-size:0.75rem; padding: 0.35rem 0.7rem;">Archivar</button>
          ` : `
            <div style="display: flex; gap: 0.5rem;">
              <button class="restore-btn js-restore-project" data-project-id="${proj.id}" data-project-name="${proj.name}" title="Restaurar Proyecto">Restaurar</button>
              ${canDelete ? `<button class="delete-btn js-delete-permanent" data-project-id="${proj.id}" data-project-name="${proj.name}" style="background: var(--status-alert); padding: 0.25rem 0.5rem; font-size: 0.7rem;">Borrar</button>` : ''}
            </div>
          `) : ''}
        </div>

        <div style="text-align: right;">
          <span style="font-size: 1.15rem; font-weight: 800; color: #38bdf8;">${proj.overallProgress}%</span>
          <span style="font-size: 0.78rem; color: var(--text-muted); margin-left: 0.3rem;">Tiempo Transcurrido</span>
        </div>
      </div>
    </div>

    <!-- Calendar Progress Bar -->
    <div class="progress-container" style="margin: 0.75rem 0 1.25rem; height: 7px; background: rgba(255,255,255,0.08);">
      <div class="progress-bar" style="width: ${proj.overallProgress}%; background: ${proj.health === 'completed' ? 'var(--status-done)' : (proj.health === 'delayed' ? 'var(--exec-soft-coral)' : (proj.health === 'at_risk' ? '#f59e0b' : 'linear-gradient(90deg, #38bdf8, #6366f1)'))};"></div>
    </div>

    <!-- Feed / Historial de Actualizaciones -->
    <div style="background: rgba(3, 11, 30, 0.5); border-radius: 12px; border: 1px solid rgba(56, 189, 248, 0.15); padding: 1rem; margin-top: 1rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.5rem;">
        <span style="font-size: 0.8rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 0.4rem;">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
          Historial de Actualizaciones (${commentLines.length})
        </span>
      </div>

      <div style="max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem;" class="custom-scrollbar">
        ${commentLines.length > 0 ? commentLines.slice().reverse().map(line => {
          let badge = '🔹';
          if (line.includes('🟢')) badge = '🟢';
          else if (line.includes('🟡')) badge = '🟡';
          else if (line.includes('🔴')) badge = '🔴';
          
          return `
            <div style="font-size: 0.82rem; padding: 0.5rem 0.75rem; background: rgba(255,255,255,0.03); border-radius: 8px; border-left: 3px solid ${badge === '🔴' ? '#f87171' : (badge === '🟡' ? '#fbbf24' : '#38bdf8')}; color: #e2e8f0; line-height: 1.4;">
              ${escapeHtml(line)}
            </div>
          `;
        }).join('') : `<p style="font-size: 0.8rem; color: var(--text-muted); margin: 0;">Sin actualizaciones registradas por el líder aún. Usa el bot de Telegram para reportar avances.</p>`}
      </div>
    </div>

    <!-- Chevron toggle for mini Gantt -->
    <div style="display:flex; justify-content:center; margin-top:1rem; padding-top:0.5rem;">
      <button
        id="gantt-toggle-${safeId}"
        onclick="window.toggleProjectGantt('${safeId}')"
        style="background:transparent; border:none; color:${isExpanded ? 'var(--accent-primary)' : 'var(--text-muted)'}; cursor:pointer; display:flex; align-items:center; gap:0.4rem; font-size:0.75rem; padding:0.25rem 1rem; transition:color 0.2s;"
        title="Ver barra de cronograma"
      >
        <span>Cronograma</span>
        <svg id="gantt-chevron-${safeId}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="transition:transform 0.3s; transform: ${isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'};">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
    </div>

    <!-- Hidden per-project mini Gantt -->
    <div id="gantt-panel-${safeId}" style="display:${isExpanded ? 'block' : 'none'}; overflow-x:auto; margin-top:0.5rem; border-top:1px solid var(--card-border); background:rgba(0,0,0,0.15); border-radius:0 0 var(--border-radius-lg) var(--border-radius-lg);">
      ${buildPhaseGanttTable(proj, appState.ganttViewMode === 'months' ? getMonthsForPhases(proj.phases) : getWeeksForPhases(proj.phases), projColor)}
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
  renderProjects(); // Added to filter project list too
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

window.handleMetaBlur = async function(el, projectId, field) {
  const newValue = el.innerText.replace(/\s+/g, ' ').trim();
  const proj = appState.projects.find(p => p.id === projectId);
  if (!proj) return;

  const oldName = proj.name; // Current name before update
  const newName = field === 'name' ? newValue : proj.name;
  const newResp = field === 'responsible' ? newValue : proj.responsible;

  if (newName === proj.name && newResp === proj.responsible) {
    el.innerText = newValue; // normalize UI
    return;
  }

  // Update frozen IDs optimistically to maintain visual position even after rename
  // Note: We now use projectId for frozen IDs, so renaming the name doesn't affect the ID
  // Unless the ID was derived from the name (legacy). But we've switched to projectId.

  try {
    await updateProjectMeta(db, projectId, newName, newResp, proj.client);
  } catch (err) {
    console.error("Error updating meta:", err);
    appState.needsResort = true;
    el.innerText = field === 'name' ? proj.name : proj.responsible;
    alert("Error al actualizar. Se han restaurado los valores originales.");
  }
};

window.handleClientChange = async function(projectId, newClient) {
  const proj = appState.projects.find(p => p.id === projectId);
  if (!proj) return;
  
  try {
    await updateProjectMeta(db, proj.id, proj.name, proj.responsible, newClient);
    appState.needsResort = true;
  } catch (err) {
    console.error("Error updating client:", err);
    alert("Error al actualizar el cliente.");
  }
};

window.confirmArchiveProject = async function(projectId, projectName) {
  const title = "Archivar Proyecto";
  const message = `¿Deseas enviar el proyecto "${projectName}" a la papelera? Podrás restaurarlo más tarde si es necesario.`;
  
  showConfirmModal(title, message, async () => {
    try {
      await archiveProject(db, projectId, appState.currentUser);
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

window.confirmDeleteProjectPermanently = async function(projectId, projectName) {
  console.log("main.js: confirmDeleteProjectPermanently invocado para:", projectId);
  
  const title = "Eliminar de forma permanente";
  const message = `¿Estás completamente seguro de eliminar el proyecto "${projectName}"?\n\nEsta acción borrará todos los registros de la base de datos y NO se puede deshacer.`;
  
  showConfirmModal(title, message, async () => {
    console.log("main.js: Eliminación confirmada en modal.");
    try {
      showLoading();
      await deleteProjectPermanently(db, projectId, appState.currentUser);
      
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

window.confirmRestoreProject = async function(projectId, projectName) {
  const title = "Restaurar Proyecto";
  const message = `¿Deseas restaurar "${projectName}"? El proyecto dejará de estar en la papelera y volverá a ser un proyecto activo.`;
  
  showConfirmModal(title, message, async () => {
    try {
      await restoreProject(db, projectId, appState.currentUser);
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

  document.getElementById('showLogsBtn')?.addEventListener('click', () => {
    window.showLogsView();
  });

  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#logs') {
      window.showLogsView();
    } else if (window.location.hash === '' || window.location.hash === '#') {
      window.showMainView();
    }
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
      window.confirmDeleteProjectPermanently(permBtn.dataset.projectId, permBtn.dataset.projectName);
      return;
    }
    
    const restoreBtn = e.target.closest('.js-restore-project');
    if (restoreBtn) {
      window.confirmRestoreProject(restoreBtn.dataset.projectId, restoreBtn.dataset.projectName);
      return;
    }

    const archiveBtn = e.target.closest('.js-archive-project');
    if (archiveBtn) {
      window.confirmArchiveProject(archiveBtn.dataset.projectId, archiveBtn.dataset.projectName);
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

  const dateRangeInput = document.getElementById('editDateRange');
  const displayStart   = document.getElementById('displayStartDate');
  const displayEnd     = document.getElementById('displayEndDate');

  // Format a YYYY-MM-DD string as DD/MM/YYYY for display
  function fmtDisplay(yyyymmdd) {
    if (!yyyymmdd) return '—';
    const [y, m, d] = yyyymmdd.split('-');
    return `${d}/${m}/${y}`;
  }

  // Initialize single Flatpickr range picker
  appState.fpRange = flatpickr("#editDateRange", {
    mode: "range",
    altInput: true,
    altFormat: "d/m/Y",
    dateFormat: "Y-m-d",
    locale: {
      rangeSeparator: " → "
    },
    onDayCreate: (dObj, dStr, fp, dayElem) => {
      const dow = dayElem.dateObj.getDay();
      if (dow === 0 || dow === 6) {
        dayElem.classList.add('flatpickr-weekend');
      }
    },
    onChange: (selectedDates) => {
      const startVal = selectedDates[0] ? selectedDates[0].toLocaleDateString('en-CA') : '';
      const endVal   = selectedDates[1] ? selectedDates[1].toLocaleDateString('en-CA') : '';

      // Keep hidden inputs in sync
      document.getElementById('editStartDate').value = startVal;
      document.getElementById('editEndDate').value   = endVal;

      // Update the display badges
      if (displayStart) displayStart.textContent = fmtDisplay(startVal) || '—';
      if (displayEnd)   displayEnd.textContent   = fmtDisplay(endVal)   || '—';

      // Clear errors while picking
      document.getElementById('dateError').style.display = 'none';
    }
  });

  // Compatibility shims so the rest of the code still works
  appState.fpStart = {
    setDate: (v) => {},
    set: (k, v) => {
      if (k === 'maxDate') appState.fpRange.set('maxDate', v);
      if (k === 'minDate') appState.fpRange.set('minDate', v);
    }
  };
  appState.fpEnd = appState.fpStart;

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const phaseId = document.getElementById('editPhaseId').value;
    const newState = document.getElementById('editState').value;
    const newProgress = parseInt(editProgressRange.value, 10);
    const newComment = document.getElementById('editComment').value;
    const startDateVal = document.getElementById('editStartDate').value;
    const endDateVal   = document.getElementById('editEndDate').value;
    const newStartDate = fromInputDate(startDateVal);
    const newEndDate = fromInputDate(endDateVal);

    // Validate start > end
    if (startDateVal && endDateVal && startDateVal > endDateVal) {
      document.getElementById('dateError').style.display = 'block';
      return;
    }
    document.getElementById('dateError').style.display = 'none';

    // Validate against project's delivery date
    const maxAllowed = document.getElementById('editStartDate').max;
    const dateToCheck = endDateVal || startDateVal;
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

  // Initialize New Project Flatpickr range picker
  const newProjDateInput = document.getElementById('newProjectDateRange');
  if (newProjDateInput) {
    appState.fpNewProjRange = flatpickr("#newProjectDateRange", {
      mode: "range",
      altInput: true,
      altFormat: "d/m/Y",
      dateFormat: "Y-m-d",
      locale: { rangeSeparator: " → " },
      onDayCreate: (dObj, dStr, fp, dayElem) => {
        const dow = dayElem.dateObj.getDay();
        if (dow === 0 || dow === 6) dayElem.classList.add('flatpickr-weekend');
      },
      onChange: (selectedDates) => {
        const startVal = selectedDates[0] ? selectedDates[0].toLocaleDateString('en-CA') : '';
        const endVal   = selectedDates[1] ? selectedDates[1].toLocaleDateString('en-CA') : '';
        const startInput = document.getElementById('newProjectStartDate');
        const endInput = document.getElementById('newProjectEndDate');
        if (startInput) startInput.value = startVal;
        if (endInput) endInput.value = endVal;
      }
    });
  }

  const addProjectBtn = document.getElementById('addProjectBtn');
  if (addProjectBtn) {
    addProjectBtn.addEventListener('click', () => {
      const modal = document.getElementById('newProjectModal');
      const errorMsg = document.getElementById('newProjectError');
      const nameInput = document.getElementById('newProjectNameInput');
      const respInput = document.getElementById('newProjectResponsibleInput');
      const clientSelect = document.getElementById('newProjectClientSelect');

      if (modal) {
        if (errorMsg) errorMsg.style.display = 'none';
        if (nameInput) nameInput.value = '';
        if (respInput) respInput.value = '';

        if (clientSelect) {
          clientSelect.innerHTML = appState.clients.map(c => 
            `<option value="${c.name}" ${c.name === appState.selectedClient ? 'selected' : ''}>${c.name}</option>`
          ).join('');
        }

        if (appState.fpNewProjRange) {
          appState.fpNewProjRange.clear();
        }

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

    let projectName = document.getElementById('newProjectNameInput')?.value.trim();
    const clientName = document.getElementById('newProjectClientSelect')?.value || appState.selectedClient || 'General';
    const responsible = document.getElementById('newProjectResponsibleInput')?.value.trim() || '';
    const startDateVal = document.getElementById('newProjectStartDate')?.value;
    const endDateVal = document.getElementById('newProjectEndDate')?.value;

    if (!startDateVal || !endDateVal) {
      if (errorMsg) {
        errorMsg.textContent = 'Debes seleccionar el rango de fechas (Inicio y Término).';
        errorMsg.style.display = 'block';
      }
      return;
    }

    const startDate = fromInputDate(startDateVal);
    const deliveryDate = fromInputDate(endDateVal);

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creando...';

    try {
      if (!projectName) {
        const existingNames = new Set(appState.projects.map(p => p.name));
        projectName = 'Nuevo Proyecto';
        let counter = 2;
        while (existingNames.has(projectName)) {
          projectName = `Nuevo Proyecto ${counter++}`;
        }
      }

      await createNewProject(db, projectName, clientName, responsible, startDate, deliveryDate);
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

  // Settings Modal logic
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const settingsForm = document.getElementById('settingsForm');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  
  settingsBtn?.addEventListener('click', () => {
    if (geminiApiKeyInput) {
      geminiApiKeyInput.value = localStorage.getItem('geminiApiKey') || '';
    }
    settingsModal?.classList.add('active');
  });
  
  const closeSettings = () => {
    settingsModal?.classList.remove('active');
  };
  
  closeSettingsBtn?.addEventListener('click', closeSettings);
  settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  
  settingsForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (geminiApiKeyInput) {
      localStorage.setItem('geminiApiKey', geminiApiKeyInput.value.trim());
    }
    closeSettings();
  });
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

  // Compute max date from the project's Entrega phase (if not editing Entrega itself)
  const isEntrega = phase.phase === 'Entrega';
  const entregaPhase = isEntrega
    ? null
    : appState.rawPhases.find(p => p.project === phase.project && p.phase === 'Entrega');
  const maxDateVal = entregaPhase ? toInputDate(entregaPhase.endDate) : '';

  // Set max/min constraints on range picker
  appState.fpRange.set('maxDate', maxDateVal || null);
  // Set initial range
  if (toInputDate(phase.startDate) || toInputDate(phase.endDate)) {
    const dates = [toInputDate(phase.startDate), toInputDate(phase.endDate)].filter(Boolean);
    appState.fpRange.setDate(dates);
  } else {
    appState.fpRange.clear();
  }

  // Update display badges
  const displayStart = document.getElementById('displayStartDate');
  const displayEnd   = document.getElementById('displayEndDate');
  if (displayStart) displayStart.textContent = phase.startDate || '—';
  if (displayEnd)   displayEnd.textContent   = phase.endDate   || '—';

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

// ═════════════════════════════════════════════════════════════════════════════
// EXECUTIVE SUMMARY MODULE (VISTA DIRECTIVA / GERENCIA)
// ═════════════════════════════════════════════════════════════════════════════

window.switchAppView = function(view) {
  // Only gerente and admin roles can access the executive view
  if (view === 'executive' && appState.currentUserRole !== 'gerente' && appState.currentUserRole !== 'admin') {
    view = 'main';
  }

  appState.currentView = view;
  
  const mainSection = document.getElementById('mainSection');
  const execSection = document.getElementById('executiveSection');
  const logsSection = document.getElementById('logsSection');
  const viewMainBtn = document.getElementById('viewMainBtn');
  const viewExecBtn = document.getElementById('viewExecBtn');
  const viewModeSelector = document.getElementById('viewModeSelector');
  const isGerente = appState.currentUserRole === 'gerente' || appState.currentUserRole === 'admin';

  if (view === 'executive') {
    if (mainSection) mainSection.style.display = 'none';
    if (execSection) execSection.style.display = 'flex';
    if (logsSection) logsSection.style.display = 'none';
    if (viewExecBtn) viewExecBtn.classList.add('active');
    if (viewMainBtn) viewMainBtn.classList.remove('active');
    if (viewModeSelector) viewModeSelector.style.display = 'inline-flex';
    if (window.location.hash !== '#executive') window.location.hash = 'executive';
    renderExecutiveView();
  } else if (view === 'logs') {
    if (mainSection) mainSection.style.display = 'none';
    if (execSection) execSection.style.display = 'none';
    if (logsSection) logsSection.style.display = 'flex';
    if (viewModeSelector) viewModeSelector.style.display = 'none';
    if (window.location.hash !== '#logs') window.location.hash = 'logs';
    renderLogs();
  } else {
    if (mainSection) mainSection.style.display = 'flex';
    if (execSection) execSection.style.display = 'none';
    if (logsSection) logsSection.style.display = 'none';
    if (viewMainBtn) viewMainBtn.classList.add('active');
    if (viewExecBtn) viewExecBtn.classList.remove('active');
    // Only show the view switcher to gerente and admin users
    if (viewModeSelector) viewModeSelector.style.display = isGerente ? 'inline-flex' : 'none';
    if (window.location.hash === '#logs' || window.location.hash === '#executive') window.location.hash = '';
    render();
  }
};

window.showLogsView = function() {
  window.switchAppView('logs');
};

window.showMainView = function() {
  window.switchAppView('main');
};

function setupExecutiveEventListeners() {
  const clientFilter = document.getElementById('execClientFilter');
  if (clientFilter) {
    clientFilter.addEventListener('change', (e) => {
      appState.execSelectedClient = e.target.value;
      renderExecutiveView();
    });
  }

  const searchInput = document.getElementById('execSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      appState.execSearchQuery = e.target.value.toLowerCase().trim();
      const filtered = getExecutiveProjects();
      renderExecutiveProjectsTable(filtered);
    });
  }

  const closeAiModalBtn = document.getElementById('closeExecutiveAiModalBtn');
  const aiModal = document.getElementById('executiveAiModal');
  if (closeAiModalBtn && aiModal) {
    closeAiModalBtn.addEventListener('click', () => aiModal.classList.remove('active'));
    aiModal.addEventListener('click', (e) => {
      if (e.target === aiModal) aiModal.classList.remove('active');
    });
  }
}

function getExecutiveProjects() {
  let list = appState.projects.filter(p => !p.isArchived);

  // Lector role client security restrictions
  if (appState.currentUserRole === 'lector') {
    const allowed = appState.currentUserProfile?.allowedClients || [];
    list = list.filter(p => allowed.includes(p.client));
  }

  // Filter by selected executive client
  if (appState.execSelectedClient && appState.execSelectedClient !== 'all') {
    list = list.filter(p => p.client === appState.execSelectedClient);
  }

  return list;
}

function renderExecutiveView() {
  const execSection = document.getElementById('executiveSection');
  if (!execSection || execSection.style.display === 'none') return;

  // Render Date Badge
  const dateBadge = document.getElementById('execCurrentDateBadge');
  if (dateBadge) {
    const now = new Date();
    const options = { day: 'numeric', month: 'long', year: 'numeric' };
    dateBadge.textContent = `📅 ${now.toLocaleDateString('es-CL', options)}`;
  }

  // Populate Client Filter dropdown
  const clientFilter = document.getElementById('execClientFilter');
  if (clientFilter) {
    let clients = appState.clients;
    if (appState.currentUserRole === 'lector') {
      const allowed = appState.currentUserProfile?.allowedClients || [];
      clients = clients.filter(c => allowed.includes(c.name));
    }

    const currentVal = appState.execSelectedClient || 'all';
    clientFilter.innerHTML = `
      <option value="all" ${currentVal === 'all' ? 'selected' : ''}>🌐 Portafolio Global (Todos)</option>
      ${clients.map(c => `
        <option value="${c.name}" ${currentVal === c.name ? 'selected' : ''}>📁 ${c.name}</option>
      `).join('')}
    `;
  }

  const projects = getExecutiveProjects();

  renderExecutiveCustomKPIs(projects);
  renderExecutiveScatterPlot(projects);
  renderExecutiveKPIs(projects);
  renderExecutiveRisks(projects);
  renderExecutiveDeliveries(projects);
  renderExecutiveHealthFilters();
  renderExecutiveProjectsTable(projects);
}

function renderExecutiveCustomKPIs(projects) {
  const container = document.getElementById('execCustomKpisContainer');
  if (!container) return;

  const total = projects.length;
  const completed = projects.filter(p => p.status === 'Completado').length;

  // SLA = percentage of projects not delayed
  const delayed = projects.filter(p => p.health === 'delayed').length;
  const slaVal = total > 0 ? Math.round(((total - delayed) / total) * 100) : 100;

  // Average business days to finish a project
  const parseLocalDDMMYYYY = (str) => {
    if (!str) return null;
    const [d, m, y] = str.split('/');
    return new Date(+y, +m - 1, +d);
  };

  const calculateBusinessDays = (startStr, endStr) => {
    if (!startStr || !endStr) return null;
    const start = parseLocalDDMMYYYY(startStr);
    const end = parseLocalDDMMYYYY(endStr);
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    if (start > end) return 0;
    
    let count = 0;
    let cur = new Date(start);
    while (cur <= end) {
      const day = cur.getDay();
      if (day !== 0 && day !== 6) { // 0 = Sunday, 6 = Saturday
        count++;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  };

  const completedProjects = projects.filter(p => p.status === 'Completado');
  let totalDays = 0;
  let completedWithDates = 0;
  completedProjects.forEach(p => {
    const days = calculateBusinessDays(p.startDate, p.deliveryDate);
    if (days !== null) {
      totalDays += days;
      completedWithDates++;
    }
  });

  let avgLabel = 'Días hábiles promedio (Proyectos Completados)';
  let avgVal = completedWithDates > 0 ? Math.round(totalDays / completedWithDates) : null;
  if (avgVal === null) {
    // Fallback to active projects planned duration
    let activeDays = 0;
    let activeWithDates = 0;
    projects.filter(p => p.status !== 'Completado').forEach(p => {
      const days = calculateBusinessDays(p.startDate, p.deliveryDate);
      if (days !== null) {
        activeDays += days;
        activeWithDates++;
      }
    });
    avgVal = activeWithDates > 0 ? Math.round(activeDays / activeWithDates) : 0;
    avgLabel = 'Días hábiles promedio (Proyectos Activos)';
  }

  // Recommendation logic
  let recommendation = '';
  let recIcon = '';
  let recColor = '';
  if (total === 0) {
    recommendation = 'No hay proyectos en esta cartera para generar recomendaciones.';
    recIcon = 'ℹ️';
    recColor = 'var(--text-muted)';
  } else if (slaVal < 80) {
    recommendation = `SLA crítico (${slaVal}%). Se sugiere revisar cuellos de botella e incrementar recursos en fases finales.`;
    recIcon = '⚠️';
    recColor = 'var(--exec-soft-coral)';
  } else if (delayed > 0) {
    recommendation = `Hay ${delayed} proyecto(s) retrasado(s). Priorizar cierres de la fase de entrega para normalizar la cartera.`;
    recIcon = '⚡';
    recColor = 'var(--exec-soft-amber)';
  } else if (slaVal >= 95) {
    recommendation = 'Excelente rendimiento general. Portafolio alineado al cronograma comprometido. Mantener esquema actual.';
    recIcon = '🏆';
    recColor = 'var(--exec-soft-green)';
  } else {
    recommendation = 'Cartera operativa estable. Monitorear los proyectos en riesgo para evitar desviaciones en fechas de entrega.';
    recIcon = '📈';
    recColor = 'var(--exec-soft-blue)';
  }

  container.innerHTML = `
    <!-- Card 1: Cantidad de proyectos -->
    <div class="exec-card" style="padding: 1.25rem;">
      <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem;">Cantidad Proyectos</div>
      <div style="font-size: 2rem; font-weight: 800; color: var(--text-main);">${total}</div>
      <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem;">Registrados en cartera</div>
    </div>

    <!-- Card 2: Cantidad de proyectos completados -->
    <div class="exec-card" style="padding: 1.25rem;">
      <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem;">Proyectos Completados</div>
      <div style="font-size: 2rem; font-weight: 800; color: var(--exec-soft-blue);">${completed}</div>
      <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem;">Finalizados con 100% de avance</div>
    </div>

    <!-- Card 3: SLA -->
    <div class="exec-card" style="padding: 1.25rem;">
      <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem;">Nivel de SLA</div>
      <div style="font-size: 2rem; font-weight: 800; color: ${slaVal >= 90 ? 'var(--exec-soft-green)' : (slaVal >= 80 ? 'var(--exec-soft-amber)' : 'var(--exec-soft-coral)')};">${slaVal}%</div>
      <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem;">Proporción de proyectos sin retrasos</div>
    </div>

    <!-- Card 4: Días laborales promedio -->
    <div class="exec-card" style="padding: 1.25rem;">
      <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem;">Días Hábiles Promedio</div>
      <div style="font-size: 2rem; font-weight: 800; color: var(--text-main);">${avgVal} <span style="font-size: 1rem; font-weight: 400; color: var(--text-muted);">días</span></div>
      <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem;">${avgLabel}</div>
    </div>

    <!-- Card 5: Recomendación -->
    <div class="exec-card" style="padding: 1.25rem; display: flex; flex-direction: column; justify-content: space-between; border-left: 3px solid ${recColor};">
      <div>
        <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem;">Recomendación PMO</div>
        <div style="font-size: 0.78rem; line-height: 1.4; color: var(--text-main); font-style: italic;">
          ${recIcon} "${recommendation}"
        </div>
      </div>
    </div>
  `;
}

function renderExecutiveScatterPlot(projects) {
  const container = document.getElementById('execScatterPlotContainer');
  if (!container) return;

  const parseLocalDDMMYYYY = (str) => {
    if (!str) return null;
    const [d, m, y] = str.split('/');
    return new Date(+y, +m - 1, +d);
  };

  const formatDateShort = (date) => {
    if (!date) return '';
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    return `${d}/${m}`;
  };

  const dataPoints = projects
    .map(p => ({
      name: p.name,
      client: p.client,
      progress: p.overallProgress || 0,
      health: p.health,
      healthLabel: p.healthLabel,
      deliveryDateStr: p.deliveryDate,
      dateObj: parseLocalDDMMYYYY(p.deliveryDate)
    }))
    .filter(dp => dp.dateObj)
    .sort((a, b) => a.dateObj - b.dateObj);

  if (dataPoints.length === 0) {
    container.innerHTML = `
      <h3 style="font-size: 1.1rem; font-weight: 600; margin: 0; color: var(--text-main);">Cronograma de Cumplimiento (Entregas vs. Progreso)</h3>
      <div style="padding: 3rem; text-align: center; color: var(--text-muted); font-size: 0.9rem;">
        No hay suficientes proyectos con fecha de entrega para graficar en esta cartera.
      </div>
    `;
    return;
  }

  const width = 800;
  const height = 280;
  const paddingLeft = 50;
  const paddingRight = 40;
  const paddingTop = 20;
  const paddingBottom = 40;

  const minTime = Math.min(...dataPoints.map(dp => dp.dateObj.getTime()));
  const maxTime = Math.max(...dataPoints.map(dp => dp.dateObj.getTime()));

  let timeRange = maxTime - minTime;
  if (timeRange === 0) {
    timeRange = 1000 * 60 * 60 * 24 * 10;
  }

  const getX = (time) => {
    return paddingLeft + ((time - minTime) / timeRange) * (width - paddingLeft - paddingRight);
  };

  const getY = (progress) => {
    return height - paddingBottom - (progress / 100) * (height - paddingTop - paddingBottom);
  };

  let gridYHtml = '';
  for (let p = 0; p <= 100; p += 25) {
    const yVal = getY(p);
    gridYHtml += `
      <line x1="${paddingLeft}" y1="${yVal}" x2="${width - paddingRight}" y2="${yVal}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
      <text x="${paddingLeft - 10}" y="${yVal + 4}" fill="var(--text-muted)" font-size="10" text-anchor="end">${p}%</text>
    `;
  }

  let gridXHtml = '';
  const numLabels = Math.min(dataPoints.length, 5);
  const step = Math.max(1, Math.floor(dataPoints.length / numLabels));
  for (let i = 0; i < dataPoints.length; i += step) {
    const dp = dataPoints[i];
    const xVal = getX(dp.dateObj.getTime());
    gridXHtml += `
      <line x1="${xVal}" y1="${paddingTop}" x2="${xVal}" y2="${height - paddingBottom}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" stroke-width="1" />
      <text x="${xVal}" y="${height - paddingBottom + 16}" fill="var(--text-muted)" font-size="10" text-anchor="middle">${formatDateShort(dp.dateObj)}</text>
    `;
  }

  const today = new Date();
  today.setHours(0,0,0,0);
  let todayLineHtml = '';
  if (today.getTime() >= minTime && today.getTime() <= maxTime) {
    const xToday = getX(today.getTime());
    todayLineHtml = `
      <line x1="${xToday}" y1="${paddingTop}" x2="${xToday}" y2="${height - paddingBottom}" stroke="var(--exec-soft-coral)" stroke-width="1.5" stroke-dasharray="4,2" />
      <text x="${xToday + 4}" y="${paddingTop + 12}" fill="var(--exec-soft-coral)" font-size="9" font-weight="600">HOY</text>
    `;
  }

  const xCriticalBoundary = getX(today.getTime());
  let criticalZoneHtml = '';
  if (today.getTime() >= minTime) {
    const criticalWidth = xCriticalBoundary - paddingLeft;
    if (criticalWidth > 0) {
      const topY = getY(100);
      const bottomY = getY(0);
      criticalZoneHtml = `
        <rect x="${paddingLeft}" y="${topY}" width="${criticalWidth}" height="${bottomY - topY}" fill="rgba(239, 68, 68, 0.02)" />
        <text x="${paddingLeft + 10}" y="${height - paddingBottom - 10}" fill="rgba(239, 68, 68, 0.3)" font-size="9" font-weight="600">ZONA CRÍTICA (VENCIDOS)</text>
      `;
    }
  }

  const dotsHtml = dataPoints.map((dp) => {
    const cx = getX(dp.dateObj.getTime());
    const cy = getY(dp.progress);

    let dotColor = 'var(--exec-soft-green)';
    if (dp.health === 'completed') dotColor = 'var(--exec-soft-blue)';
    else if (dp.health === 'at_risk') dotColor = 'var(--exec-soft-amber)';
    else if (dp.health === 'delayed') dotColor = 'var(--exec-soft-coral)';

    return `
      <g class="chart-dot" style="cursor: pointer;" onclick="window.highlightProjectInMatrix('${dp.name}')">
        <circle cx="${cx}" cy="${cy}" r="7" fill="${dotColor}" stroke="rgba(255,255,255,0.2)" stroke-width="1.5">
          <title>${dp.name} (${dp.client})\nProgreso: ${dp.progress}%\nEntrega: ${dp.deliveryDateStr}\nSalud: ${dp.healthLabel}</title>
        </circle>
        <circle cx="${cx}" cy="${cy}" r="12" fill="transparent" />
      </g>
    `;
  }).join('');

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h3 style="font-size: 1.15rem; font-weight: 600; margin: 0; color: var(--text-main);">Cronograma de Cumplimiento (Entregas vs. Progreso)</h3>
      <span style="font-size: 0.72rem; color: var(--text-muted);">Pasa el cursor sobre los puntos para ver detalles · Clic para buscar en la matriz</span>
    </div>
    <div style="position: relative; width: 100%; overflow-x: auto; background: rgba(3, 11, 30, 0.65); border-radius: 12px; border: 1px solid rgba(56, 189, 248, 0.2); padding: 1rem 0.5rem 0.5rem 0.5rem;">
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="min-width: 600px; display: block;">
        ${criticalZoneHtml}
        ${gridYHtml}
        ${gridXHtml}
        ${todayLineHtml}
        
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${height - paddingBottom}" stroke="rgba(56, 189, 248, 0.2)" stroke-width="1" />
        <line x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom}" stroke="rgba(56, 189, 248, 0.2)" stroke-width="1" />
        
        ${dotsHtml}
      </svg>
    </div>
  `;
}

window.highlightProjectInMatrix = function(projName) {
  const searchInput = document.getElementById('execSearchInput');
  if (searchInput) {
    searchInput.value = projName;
    appState.execSearchQuery = projName.toLowerCase().trim();
    const filtered = getExecutiveProjects();
    renderExecutiveProjectsTable(filtered);
    
    const tableBody = document.getElementById('execProjectsTableBody');
    if (tableBody) {
      tableBody.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
};

function renderExecutiveKPIs(projects) {
  const container = document.getElementById('execKpisContainer');
  if (!container) return;

  const total = projects.length;
  const onTrack = projects.filter(p => p.health === 'on_track').length;
  const atRisk = projects.filter(p => p.health === 'at_risk').length;
  const delayed = projects.filter(p => p.health === 'delayed').length;
  const completed = projects.filter(p => p.health === 'completed').length;

  const activeProjects = projects.filter(p => p.status !== 'Completado');
  const avgProgress = activeProjects.length > 0
    ? Math.round(activeProjects.reduce((sum, p) => sum + (p.overallProgress || 0), 0) / activeProjects.length)
    : (total > 0 ? 100 : 0);

  // Deliveries in next 30 days
  const upcomingDeliveries = activeProjects.filter(p => p.daysRemaining !== null && p.daysRemaining >= 0 && p.daysRemaining <= 30);

  // Active phases distribution
  const phaseCounts = { 'Levantamiento': 0, 'Desarrollo': 0, 'Testing/QA': 0, 'Entrega': 0 };
  activeProjects.forEach(p => {
    if (phaseCounts[p.currentPhase] !== undefined) {
      phaseCounts[p.currentPhase]++;
    }
  });

  container.innerHTML = `
    <!-- KPI 1: Salud General -->
    <div class="exec-card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem;">
        <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Salud de Cartera</span>
        <span class="exec-pill exec-pill-purple">${total} proyectos</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; margin-top: 0.75rem;">
        <div style="background: var(--exec-soft-green-bg); border: 1px solid var(--exec-soft-green-border); padding: 0.6rem 0.75rem; border-radius: 10px;">
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--exec-soft-green);">${onTrack}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">A Tiempo</div>
        </div>
        <div style="background: var(--exec-soft-amber-bg); border: 1px solid var(--exec-soft-amber-border); padding: 0.6rem 0.75rem; border-radius: 10px;">
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--exec-soft-amber);">${atRisk}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">En Riesgo</div>
        </div>
        <div style="background: var(--exec-soft-coral-bg); border: 1px solid var(--exec-soft-coral-border); padding: 0.6rem 0.75rem; border-radius: 10px;">
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--exec-soft-coral);">${delayed}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">Retrasados</div>
        </div>
        <div style="background: var(--exec-soft-blue-bg); border: 1px solid var(--exec-soft-blue-border); padding: 0.6rem 0.75rem; border-radius: 10px;">
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--exec-soft-blue);">${completed}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">Completados</div>
        </div>
      </div>
    </div>

    <!-- KPI 2: Avance Ponderado -->
    <div class="exec-card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
        <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Avance Promedio</span>
        <span class="exec-pill exec-pill-green">${activeProjects.length} en curso</span>
      </div>
      <div style="display: flex; align-items: baseline; gap: 0.5rem; margin: 0.5rem 0;">
        <span style="font-size: 2.2rem; font-weight: 800; color: var(--text-main); line-height: 1;">${avgProgress}%</span>
        <span style="font-size: 0.85rem; color: var(--exec-soft-green); font-weight: 600;">Progreso global</span>
      </div>
      <div class="exec-progress-wrap" style="height: 8px; margin: 0.75rem 0 0.5rem;">
        <div class="exec-progress-fill" style="width: ${avgProgress}%; background: linear-gradient(90deg, #6366f1, #6ee7b7);"></div>
      </div>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin: 0;">Calculado sobre todas las fases de proyectos activos.</p>
    </div>

    <!-- KPI 3: Próximas Entregas -->
    <div class="exec-card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
        <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Hitos del Mes</span>
        <span class="exec-pill exec-pill-blue">Próximos 30 días</span>
      </div>
      <div style="display: flex; align-items: baseline; gap: 0.5rem; margin: 0.5rem 0;">
        <span style="font-size: 2.2rem; font-weight: 800; color: var(--exec-soft-blue); line-height: 1;">${upcomingDeliveries.length}</span>
        <span style="font-size: 0.85rem; color: var(--text-muted);">Entregas críticas</span>
      </div>
      <div style="margin-top: 0.75rem; font-size: 0.78rem; color: var(--text-muted); line-height: 1.4;">
        ${upcomingDeliveries.length > 0 
          ? `Próxima entrega: <strong style="color:#e0e7ff;">${upcomingDeliveries[0].name}</strong> (${upcomingDeliveries[0].deliveryDate || 'Pronto'})`
          : 'No hay cierres programados para las próximas 4 semanas.'}
      </div>
    </div>

    <!-- KPI 4: Distribución por Fases -->
    <div class="exec-card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
        <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Fase Activa Actual</span>
        <span class="exec-pill exec-pill-purple">Distribución</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.45rem; margin-top: 0.6rem;">
        ${Object.entries(phaseCounts).map(([phaseName, count]) => `
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.78rem;">
            <span style="color: var(--text-muted);">${phaseName}</span>
            <span style="font-weight: 700; color: var(--text-main);">${count}</span>
          </div>
          <div class="exec-progress-wrap" style="height: 4px; margin-bottom: 0.2rem;">
            <div class="exec-progress-fill" style="width: ${activeProjects.length > 0 ? (count / activeProjects.length) * 100 : 0}%; background: ${PHASE_COLORS[phaseName] || '#6366f1'};"></div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderExecutiveRisks(projects) {
  const container = document.getElementById('execRisksList');
  const countBadge = document.getElementById('execRisksCountBadge');
  if (!container) return;

  const atRiskList = projects.filter(p => p.health === 'delayed' || p.health === 'at_risk');

  if (countBadge) {
    countBadge.textContent = `${atRiskList.length} ${atRiskList.length === 1 ? 'alerta' : 'alertas'}`;
    countBadge.className = atRiskList.length > 0 ? 'exec-pill exec-pill-coral' : 'exec-pill exec-pill-green';
  }

  if (atRiskList.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem 1rem; text-align: center; color: var(--exec-soft-green);">
        <svg width="28" height="28" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" style="margin-bottom: 0.5rem;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p style="margin: 0; font-size: 0.88rem; font-weight: 600;">Todo en orden</p>
        <p style="margin: 0.2rem 0 0; font-size: 0.75rem; color: var(--text-muted);">No se detectan desviaciones ni atrasos en esta cartera.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = atRiskList.map(proj => {
    const isDelayed = proj.health === 'delayed';
    const pillClass = isDelayed ? 'exec-pill-coral' : 'exec-pill-amber';
    const initials = (proj.responsible || '?').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();

    let reason = '';
    if (isDelayed) {
      reason = `Fecha de entrega (${proj.deliveryDate || 'Entrega'}) no cumplida.`;
    } else {
      const overduePhase = proj.phases.find(p => p.state !== 'Finalizado' && p.endDate && parseDate(p.endDate) < new Date());
      if (overduePhase) {
        reason = `Fase intermedia "${overduePhase.phase}" atrasada (${overduePhase.endDate}).`;
      } else if (proj.daysRemaining !== null && proj.daysRemaining <= 7) {
        reason = `Entrega cercana (${proj.daysRemaining}d restantes) con avance rezagado (${proj.overallProgress}%).`;
      } else {
        reason = 'Proyecto con inicio pendiente o riesgo en cronograma.';
      }
    }

    return `
      <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); border-left: 3px solid ${isDelayed ? 'var(--exec-soft-coral)' : 'var(--exec-soft-amber)'}; border-radius: 10px; padding: 0.75rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.2rem;">
            <strong style="font-size: 0.85rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${proj.name}</strong>
            <span class="exec-pill ${pillClass}" style="font-size: 0.65rem; padding: 0.1rem 0.45rem;">${proj.healthLabel}</span>
          </div>
          <div style="font-size: 0.74rem; color: var(--text-muted);">${reason}</div>
        </div>

        <div style="display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0;">
          <div style="text-align: right;">
            <div style="font-size: 0.85rem; font-weight: 700; color: ${isDelayed ? 'var(--exec-soft-coral)' : 'var(--exec-soft-amber)'};">${proj.overallProgress}%</div>
            <div style="font-size: 0.68rem; color: var(--text-muted);">${proj.client}</div>
          </div>
          <div style="width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; color: #e0e7ff;" title="${proj.responsible || 'Sin asignar'}">
            ${initials}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderExecutiveDeliveries(projects) {
  const container = document.getElementById('execDeliveriesList');
  if (!container) return;

  const deliveries = projects
    .filter(p => p.status !== 'Completado' && p.deliveryDate)
    .sort((a, b) => (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999))
    .slice(0, 6);

  if (deliveries.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem 1rem; text-align: center; color: var(--text-muted);">
        <p style="margin: 0; font-size: 0.85rem;">No hay entregas registradas en esta vista.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = deliveries.map(proj => {
    const days = proj.daysRemaining;
    let daysBadge = '';
    if (days !== null) {
      if (days < 0) {
        daysBadge = `<span class="exec-pill exec-pill-coral">Vencido hace ${Math.abs(days)}d</span>`;
      } else if (days === 0) {
        daysBadge = `<span class="exec-pill exec-pill-coral">¡Entrega Hoy!</span>`;
      } else if (days <= 7) {
        daysBadge = `<span class="exec-pill exec-pill-amber">Quedan ${days}d</span>`;
      } else {
        daysBadge = `<span class="exec-pill exec-pill-blue">Quedan ${days}d</span>`;
      }
    }

    return `
      <div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; padding: 0.75rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <strong style="font-size: 0.85rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${proj.name}</strong>
            <span style="font-size: 0.72rem; color: var(--text-muted);">(${proj.client})</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.6rem; font-size: 0.74rem; color: var(--text-muted);">
            <span>Fecha: <strong style="color: #cbd5e1;">${proj.deliveryDate}</strong></span>
            <span>·</span>
            <span>Resp: ${proj.responsible || 'Sin asignar'}</span>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0;">
          ${daysBadge}
          <div style="width: 50px; text-align: right; font-weight: 700; font-size: 0.85rem; color: var(--text-main);">
            ${proj.overallProgress}%
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderExecutiveHealthFilters() {
  const container = document.getElementById('execHealthFilters');
  if (!container) return;

  const filters = [
    { key: 'all', label: 'Todos' },
    { key: 'on_track', label: 'A Tiempo' },
    { key: 'at_risk', label: 'En Riesgo' },
    { key: 'delayed', label: 'Retrasados' },
    { key: 'completed', label: 'Completados' }
  ];

  container.innerHTML = filters.map(f => {
    const isActive = (appState.execHealthFilter || 'all') === f.key;
    return `
      <button onclick="window.setExecutiveHealthFilter('${f.key}')" class="status-filter-btn ${isActive ? 'active' : ''}" style="font-size: 0.72rem; padding: 0.25rem 0.65rem; border-radius: 999px; border: 1px solid var(--card-border); background: ${isActive ? 'var(--accent-primary)' : 'rgba(255,255,255,0.04)'}; color: ${isActive ? 'white' : 'var(--text-muted)'}; cursor: pointer;">
        ${f.label}
      </button>
    `;
  }).join('');
}

window.setExecutiveHealthFilter = function(filterKey) {
  appState.execHealthFilter = filterKey;
  renderExecutiveHealthFilters();
  const projects = getExecutiveProjects();
  renderExecutiveProjectsTable(projects);
};

function renderExecutiveProjectsTable(projects) {
  const tbody = document.getElementById('execProjectsTableBody');
  if (!tbody) return;

  let filtered = projects;

  // Filter by health
  if (appState.execHealthFilter && appState.execHealthFilter !== 'all') {
    filtered = filtered.filter(p => p.health === appState.execHealthFilter);
  }

  // Filter by search query
  if (appState.execSearchQuery) {
    const q = appState.execSearchQuery.toLowerCase();
    filtered = filtered.filter(p => 
      p.name.toLowerCase().includes(q) ||
      (p.responsible && p.responsible.toLowerCase().includes(q)) ||
      (p.client && p.client.toLowerCase().includes(q))
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--text-muted); font-size: 0.88rem;">
          No se encontraron proyectos con los filtros seleccionados.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(proj => {
    let healthPill = '';
    if (proj.health === 'on_track') healthPill = '<span class="exec-pill exec-pill-green">A Tiempo</span>';
    else if (proj.health === 'at_risk') healthPill = '<span class="exec-pill exec-pill-amber">En Riesgo</span>';
    else if (proj.health === 'delayed') healthPill = '<span class="exec-pill exec-pill-coral">Retrasado</span>';
    else healthPill = '<span class="exec-pill exec-pill-blue">Completado</span>';

    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.15rem;">
            ${proj.name}
          </div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">
            ${proj.phases.length} fases configuradas
          </div>
        </td>
        <td>
          <span class="exec-pill exec-pill-purple" style="font-size: 0.72rem;">${proj.client || 'General'}</span>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.84rem;">
            <div style="width: 22px; height: 22px; border-radius: 50%; background: rgba(99,102,241,0.2); color: #a5b4fc; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 700;">
              ${(proj.responsible || '?')[0].toUpperCase()}
            </div>
            <span>${proj.responsible || 'Sin asignar'}</span>
          </div>
        </td>
        <td>
          <span style="font-size: 0.8rem; font-weight: 500; color: ${PHASE_COLORS[proj.currentPhase] || 'var(--text-muted)'};">
            ${proj.currentPhase}
          </span>
        </td>
        <td style="min-width: 140px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem; font-size: 0.75rem;">
            <span style="color: var(--text-muted);">${proj.status}</span>
            <strong style="color: var(--text-main);">${proj.overallProgress}%</strong>
          </div>
          <div class="exec-progress-wrap">
            <div class="exec-progress-fill" style="width: ${proj.overallProgress}%; background: ${(proj.overallProgress === 100) ? 'var(--exec-soft-blue)' : 'linear-gradient(90deg, #6366f1, #6ee7b7)'};"></div>
          </div>
        </td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start;">
            ${healthPill}
            <span style="font-size: 0.72rem; color: var(--text-muted);">
              Entrega: ${proj.deliveryDate || 'Sin definir'}
            </span>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ─── Gemini AI Executive Briefing ──────────────────────────────────────────
window.generateExecutiveBriefing = async function() {
  const modal = document.getElementById('executiveAiModal');
  const contentEl = document.getElementById('executiveAiModalContent');
  if (!modal || !contentEl) return;

  modal.classList.add('active');
  contentEl.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; padding: 3rem 1rem; gap: 1rem; color: var(--text-muted);">
      <div class="spinner"></div>
      <p style="font-size: 0.95rem; color: #c7d2fe;">Analizando cartera con Gemini AI y redactando minuta ejecutiva...</p>
    </div>
  `;

  const apiKey = localStorage.getItem('geminiApiKey') || localStorage.getItem('gemini_api_key');
  if (!apiKey) {
    contentEl.innerHTML = `
      <div style="padding: 1.5rem; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 10px; color: #fca5a5;">
        <h4 style="margin: 0 0 0.5rem; color: #f87171;">API Key requerida</h4>
        <p style="margin: 0 0 1rem; font-size: 0.85rem;">Para generar la minuta ejecutiva con inteligencia artificial, debes configurar tu API Key de Gemini en Ajustes.</p>
        <button onclick="document.getElementById('executiveAiModal').classList.remove('active'); openSettingsModal();" class="primary" style="font-size: 0.8rem; padding: 0.4rem 1rem;">
          Ir a Configuración
        </button>
      </div>
    `;
    return;
  }

  const projects = getExecutiveProjects();
  const total = projects.length;
  const onTrack = projects.filter(p => p.health === 'on_track');
  const atRisk = projects.filter(p => p.health === 'at_risk');
  const delayed = projects.filter(p => p.health === 'delayed');
  const completed = projects.filter(p => p.health === 'completed');

  let projectDetailsList = projects.map(p => {
    const rawComments = (p.phases.map(ph => ph.comment).filter(Boolean).join('\n') || p.comment || p.comments || '').trim();
    return `* PROYECTO: ${p.name}
  - Cliente: ${p.client} | Responsable: ${p.responsible || 'Sin asignar'}
  - Plazo: ${p.startDate || '—'} a ${p.deliveryDate || '—'} (% Tiempo Transcurrido: ${p.overallProgress}%)
  - Estado: ${p.healthLabel}
  - Historial de Comentarios, Logros y Bloqueos:
    ${rawComments ? rawComments.split('\n').map(c => `    > ${c}`).join('\n') : '    > Sin comentarios recientes.'}`;
  }).join('\n\n');

  let payload = `
INFORMACIÓN DE LA CARTERA DE PROYECTOS (${appState.execSelectedClient === 'all' ? 'Portafolio Global' : appState.execSelectedClient}):
- Total de Proyectos: ${total}
- A Tiempo: ${onTrack.length} (${onTrack.map(p => p.name).join(', ') || 'Ninguno'})
- En Riesgo: ${atRisk.length} (${atRisk.map(p => `${p.name} [${p.overallProgress}% tiempo - Resp: ${p.responsible}]`).join(', ') || 'Ninguno'})
- Retrasados: ${delayed.length} (${delayed.map(p => `${p.name} [${p.overallProgress}% tiempo - Entrega: ${p.deliveryDate} - Resp: ${p.responsible}]`).join(', ') || 'Ninguno'})
- Completados: ${completed.length} (${completed.map(p => p.name).join(', ') || 'Ninguno'})

DETALLE Y COMENTARIOS POR PROYECTO:
${projectDetailsList || 'Sin proyectos registrados.'}
`;

  const prompt = `
Actúa como un Director de Operaciones (COO) y PMO Estratégico de alto nivel.
Genera una Minuta Ejecutiva y Briefing de Estado para la Gerencia General y Jefaturas.

Datos actuales del portafolio:
${payload}

Instrucciones de análisis y formato:
1. **Resumen Ejecutivo**: Diagnóstico global conciso (máx. 3 líneas) sobre el estado general del portafolio y cumplimiento del calendario.
2. **🔴 Alertas Rojas y Bloqueos Críticos**: Identifica específicamente todos los proyectos que tienen bloqueos activos, impedimentos externos o semáforo rojo, explicando la causa y a quién impacta.
3. **🎯 Diagnóstico de Etapa y Desviaciones**:
   - Para los proyectos activos más relevantes o en riesgo, deduce en qué etapa real se encuentran (*Levantamiento, Diseño, Desarrollo, Testing/QA, Despliegue o Bloqueado*) según los comentarios.
   - Detecta si hay discrepancias críticas (por ejemplo, si el tiempo transcurrido del calendario va en 70% o más pero los comentarios indican que siguen en fases iniciales como Levantamiento).
4. **Decisiones Estratégicas Sugeridas**: 3 recomendaciones directas y accionables para la mesa directiva para destrabar al equipo.

Utiliza un tono ejecutivo, analítico, sobrio y directo. Usa formato Markdown limpio con negritas claras y viñetas.
`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    appState.lastAiBriefingText = text;

    let html = text
      .replace(/### (.*?)\n/g, '<h4 style="color:#a5b4fc; font-size:1.05rem; margin:1.25rem 0 0.5rem;">$1</h4>')
      .replace(/## (.*?)\n/g, '<h3 style="color:#e0e7ff; font-size:1.15rem; margin:1.5rem 0 0.5rem;">$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#ffffff;">$1</strong>')
      .replace(/^\* (.*?)$/gm, '<li style="margin-bottom:0.4rem;">$1</li>')
      .replace(/\n\n/g, '<p style="margin-bottom:0.8rem;"></p>');

    contentEl.innerHTML = `
      <div style="margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
        <span class="exec-pill exec-pill-purple">Cartera: ${appState.execSelectedClient === 'all' ? 'Portafolio Global' : appState.execSelectedClient}</span>
        <span style="font-size:0.75rem; color:var(--text-muted);">Generado con Gemini 2.5 Flash</span>
      </div>
      <div>${html}</div>
    `;
  } catch (err) {
    console.error("Error generating executive briefing:", err);
    contentEl.innerHTML = `
      <div style="padding: 1.5rem; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-radius: 10px; color: #fca5a5;">
        <p style="margin:0;">Error al generar el resumen ejecutivo: ${err.message}</p>
      </div>
    `;
  }
};

window.copyExecutiveBriefing = function() {
  if (!appState.lastAiBriefingText) return;
  navigator.clipboard.writeText(appState.lastAiBriefingText).then(() => {
    const copyText = document.getElementById('copyBtnText');
    if (copyText) {
      copyText.textContent = '¡Copiado al Portapapeles!';
      setTimeout(() => { copyText.textContent = 'Copiar Minuta'; }, 2000);
    }
  });
};

function renderLogs() {
  const container = document.getElementById('logsTableBody');
  if (!container) return;
  
  if (appState.logs.length === 0) {
    container.innerHTML = `<tr><td colspan="5" style="padding: 2rem; text-align: center; color: var(--text-muted);">No hay registros de auditoría aún.</td></tr>`;
    return;
  }
  
  const getActionBadge = (action) => {
    if (action === 'ARCHIVE') return '<span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);">Archivado</span>';
    if (action === 'RESTORE') return '<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4);">Restaurado</span>';
    if (action === 'DELETE_PERMANENT') return '<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);">Borrado Físico</span>';
    return action;
  };

  container.innerHTML = appState.logs.map(log => `
    <tr style="border-bottom: 1px solid rgba(255,255,255,0.03); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
      <td style="padding: 1rem; color: var(--text-main); font-family: monospace; font-size: 0.85rem;">${log.date}</td>
      <td style="padding: 1rem; color: var(--text-muted);">${log.userEmail}</td>
      <td style="padding: 1rem;">${getActionBadge(log.action)}</td>
      <td style="padding: 1rem; font-weight: 600;">${log.projectName}</td>
      <td style="padding: 1rem; color: var(--text-muted);">${log.client || '—'}</td>
    </tr>
  `).join('');
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

// ─── User Management Panel ─────────────────────────────────────────────────────────────
const ROLE_LABELS = { admin: 'Administrador', editor: 'Editor', lector: 'Lector', gerente: 'Gerente / Jefatura' };
const ROLE_COLORS = { admin: '#2563eb', editor: '#00d2ff', lector: '#f59e0b', gerente: '#8b5cf6' };

function openUserMgmtModal() {
  if (appState.currentUserRole !== 'admin') return;
  renderUserList();
  resetUserForm();
  document.getElementById('userMgmtModal').classList.add('active');
}

function closeUserMgmtModal() {
  document.getElementById('userMgmtModal').classList.remove('active');
}

function renderUserList() {
  const container = document.getElementById('userMgmtList');
  if (!container) return;
  const users = appState.allUsers;
  if (users.length === 0) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem;">No hay usuarios registrados aún.</p>`;
    return;
  }
  const roleTag = (role) => `<span style="font-size:0.7rem;padding:0.15rem 0.6rem;border-radius:999px;background:${ROLE_COLORS[role] || '#555'}22;color:${ROLE_COLORS[role] || '#aaa'};border:1px solid ${ROLE_COLORS[role] || '#555'}44;font-weight:600;">${ROLE_LABELS[role] || role}</span>`;
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:0.5rem;">
      ${users.map(u => `
        <div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 1rem;background:rgba(0,0,0,0.15);border-radius:10px;border:1px solid rgba(255,255,255,0.05);">
          <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#ec4899);display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;color:white;flex-shrink:0;">${(u.displayName || u.email || '?')[0].toUpperCase()}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:0.9rem;">${u.displayName || '(sin nombre)'}</div>
            <div style="font-size:0.78rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${u.email}</div>
            ${u.role === 'lector' && u.allowedClients?.length ? `<div style="font-size:0.72rem;color:#f59e0b;margin-top:0.15rem;">Clientes: ${u.allowedClients.join(', ')}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem;">
            ${roleTag(u.role)}
            <button onclick="window.editUserForm('${u.uid}')" style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#a5b4fc;padding:0.25rem 0.6rem;font-size:0.75rem;border-radius:6px;">Editar</button>
            ${u.uid !== appState.currentUser?.uid ? `<button onclick="window.confirmDeleteUser('${u.uid}','${(u.email||'').replace(/'/g,"\'")}')" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#f87171;padding:0.25rem 0.6rem;font-size:0.75rem;border-radius:6px;">Eliminar</button>` : '<span style="font-size:0.7rem;color:var(--text-muted);">(tú)</span>'}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

window.onUserRoleChange = function() {
  const role = document.getElementById('userRole').value;
  const section = document.getElementById('allowedClientsSection');
  if (section) section.style.display = role === 'lector' ? 'block' : 'none';
};

function renderAllowedClientsCheckboxes(selected = []) {
  const container = document.getElementById('allowedClientsList');
  if (!container) return;
  container.innerHTML = appState.clients.map(c => `
    <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.85rem;cursor:pointer;padding:0.3rem 0.5rem;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
      <input type="checkbox" name="allowedClient" value="${c.name}" ${selected.includes(c.name) ? 'checked' : ''} style="accent-color:#6366f1;" />
      ${c.name}
    </label>
  `).join('');
}

function resetUserForm() {
  document.getElementById('editingUserId').value = '';
  document.getElementById('userUid').value = '';
  document.getElementById('userUid').disabled = false;
  document.getElementById('userEmail2').value = '';
  document.getElementById('userDisplayName').value = '';
  document.getElementById('userRole').value = 'editor';
  document.getElementById('allowedClientsSection').style.display = 'none';
  document.getElementById('userFormTitle').textContent = 'Agregar usuario';
  const errEl = document.getElementById('userMgmtError');
  if (errEl) errEl.style.display = 'none';
  renderAllowedClientsCheckboxes([]);
}

window.editUserForm = function(uid) {
  const u = appState.allUsers.find(x => x.uid === uid);
  if (!u) return;
  document.getElementById('editingUserId').value = uid;
  document.getElementById('userUid').value = u.uid;
  document.getElementById('userUid').disabled = true;
  document.getElementById('userEmail2').value = u.email || '';
  document.getElementById('userDisplayName').value = u.displayName || '';
  document.getElementById('userRole').value = u.role || 'editor';
  const section = document.getElementById('allowedClientsSection');
  if (section) section.style.display = u.role === 'lector' ? 'block' : 'none';
  renderAllowedClientsCheckboxes(u.allowedClients || []);
  document.getElementById('userFormTitle').textContent = 'Editar usuario';
};

async function saveUser() {
  const errEl = document.getElementById('userMgmtError');
  if (errEl) errEl.style.display = 'none';

  const uid         = document.getElementById('userUid').value.trim();
  const email       = document.getElementById('userEmail2').value.trim();
  const displayName = document.getElementById('userDisplayName').value.trim();
  const role        = document.getElementById('userRole').value;
  const allowedClients = role === 'lector'
    ? Array.from(document.querySelectorAll('input[name="allowedClient"]:checked')).map(cb => cb.value)
    : [];

  if (!uid) {
    if (errEl) { errEl.textContent = 'El UID es obligatorio.'; errEl.style.display = 'block'; }
    return;
  }
  if (!email) {
    if (errEl) { errEl.textContent = 'El correo es obligatorio.'; errEl.style.display = 'block'; }
    return;
  }
  if (role === 'lector' && allowedClients.length === 0) {
    if (errEl) { errEl.textContent = 'Debes seleccionar al menos un cliente para el rol Lector.'; errEl.style.display = 'block'; }
    return;
  }

  const btn = document.getElementById('saveUserBtn');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    await saveUserProfile(db, uid, { email, displayName, role, allowedClients });
    renderUserList();
    resetUserForm();
  } catch (err) {
    console.error('Error saving user:', err);
    if (errEl) { errEl.textContent = 'Error al guardar: ' + err.message; errEl.style.display = 'block'; }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar Usuario';
  }
}

window.confirmDeleteUser = function(uid, email) {
  showConfirmModal(
    'Eliminar Usuario',
    `¿Eliminar el perfil de "${email}"? Esto revoca su acceso al sistema. No elimina su cuenta de Firebase Auth.`,
    async () => {
      try {
        await deleteUserProfile(db, uid);
        renderUserList();
      } catch (err) {
        alert('Error al eliminar: ' + err.message);
      }
    }
  );
};

// ─── AI Tooltip Logic ───────────────────────────────────────────────────────
let hoverTimer = null;
const aiCache = new Map(); // Cache generated summaries

window.handleGanttHover = function(e, projectId) {
  const td = e.currentTarget;
  const span = td.querySelector('span');
  if (span) {
    span.style.color = '#3b82f6';
    span.style.transform = 'translateX(6px)';
  }

  const tooltip = document.getElementById('aiTooltip');
  const tooltipContent = document.getElementById('aiTooltipContent');
  if (!tooltip || !tooltipContent) return;
  
  // Position the tooltip near the mouse
  const x = e.clientX + 15;
  const y = e.clientY + 15;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;

  // Start a timeout to fetch AI summary (delay 600ms)
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(async () => {
    const proj = appState.projects.find(p => p.id === projectId || p.name.replace(/[^a-z0-9]/gi, '-').toLowerCase() === projectId);
    if (!proj) return;
    
    tooltip.style.display = 'block';
    // Small delay for fade in
    setTimeout(() => tooltip.style.opacity = '1', 10);
    
    if (aiCache.has(proj.name)) {
      tooltipContent.innerHTML = aiCache.get(proj.name);
      return;
    }
    
    const apiKey = localStorage.getItem('geminiApiKey');
    if (!apiKey) {
      tooltipContent.innerHTML = `No se ha configurado una API Key de Gemini. <a href="#" onclick="document.getElementById('settingsModal').classList.add('active'); return false;" style="color:var(--accent-primary);">Configurar aquí</a>.`;
      return;
    }
    
    tooltipContent.innerHTML = `Analizando <b>${proj.phases.length}</b> fases del proyecto... <div class="spinner" style="margin-top:0.5rem;width:16px;height:16px;"></div>`;
    
    // Build context for AI
    const comments = proj.phases.filter(p => p.comment && p.comment.trim() !== '').map(p => `${p.phase}: ${p.comment}`);
    let promptContext = `El proyecto "${proj.name}" está en estado "${proj.status}" con un progreso general del ${proj.overallProgress}%.`;
    if (comments.length > 0) {
      promptContext += ` Aquí están los comentarios de las fases:\n${comments.join('\n')}`;
    } else {
      promptContext += ` No hay comentarios en las fases.`;
    }
    
    const prompt = `Eres un asistente de Project Management. A continuación te doy datos del proyecto: ${promptContext}. Escribe un resumen ejecutivo y conciso (máximo 40 palabras) de la salud del proyecto. Si hay comentarios, destaca riesgos o puntos importantes en viñetas cortas. Mantén un tono profesional y utiliza formato markdown simple.`;
    
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      // Format markdown to HTML briefly (replace ** with <b>, \n with <br>)
      const htmlText = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
      aiCache.set(proj.name, htmlText);
      tooltipContent.innerHTML = htmlText;
    } catch (error) {
      console.error(error);
      tooltipContent.innerHTML = `<span style="color:#f87171;">Error al generar el resumen. Verifica tu API Key o la conexión.</span>`;
    }
  }, 600);
};

window.handleGanttLeave = function(e) {
  const td = e.currentTarget;
  const span = td.querySelector('span');
  if (span) {
    span.style.color = 'var(--text-main)';
    span.style.transform = '';
  }
  
  clearTimeout(hoverTimer);
  const tooltip = document.getElementById('aiTooltip');
  if (tooltip) {
    tooltip.style.opacity = '0';
    setTimeout(() => {
      if (tooltip.style.opacity === '0') tooltip.style.display = 'none';
    }, 200);
  }
};

// Start
init();
