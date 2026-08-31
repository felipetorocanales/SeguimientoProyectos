/**
 * projectHelpers.js - Business logic for aggregating Firestore phases into projects
 *
 * Firestore collection "phases" stores one document per project phase.
 * This module groups them into project-level objects identical to what
 * the frontend calculates in data.js, so the API response is consistent.
 */

const PHASE_ORDER = ["Levantamiento", "Desarrollo", "Testing/QA", "Entrega"];

/**
 * Groups an array of phase documents (from Firestore) into project objects.
 * @param {Array} phases - Raw phase docs from Firestore
 * @returns {Array} - Aggregated project objects
 */
function groupPhasesIntoProjects(phases) {
  const projectMap = new Map();

  for (const phase of phases) {
    if (phase.isArchived) continue;

    const key = phase.projectId || phase.project;
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        projectId: phase.projectId || key,
        name: phase.project,
        client: phase.client || "General",
        responsible: phase.responsible || "",
        phases: [],
      });
    }
    projectMap.get(key).phases.push(phase);
  }

  const projects = [];

  for (const proj of projectMap.values()) {
    // Sort phases in standard order
    proj.phases.sort(
      (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)
    );

    // Delivery date = endDate of last phase (Entrega)
    const entregaPhase = proj.phases.find((p) => p.phase === "Entrega");
    const deliveryDate = entregaPhase?.endDate || "";

    // Overall progress = average of all phase progresses
    const totalProgress =
      proj.phases.reduce((sum, p) => sum + (p.progress || 0), 0) /
      proj.phases.length;
    const overallProgress = Math.round(totalProgress);

    // Health calculation
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let health = "on_track";
    let healthLabel = "A tiempo";
    let status = "En curso";

    const allCompleted = proj.phases.every(
      (p) => p.state === "Completado" || p.progress === 100
    );
    if (allCompleted) {
      health = "completed";
      healthLabel = "Completado";
      status = "Completado";
    } else {
      // Check if delivery phase is overdue
      if (entregaPhase && entregaPhase.state !== "Completado") {
        const deliveryEnd = parseDate(entregaPhase.endDate);
        if (deliveryEnd && today > deliveryEnd) {
          health = "delayed";
          healthLabel = "Retrasado";
          status = "Retrasado";
        }
      }

      // Check intermediate phases for risk
      if (health === "on_track") {
        for (const phase of proj.phases) {
          if (phase.phase === "Entrega") continue;
          if (phase.state === "Completado") continue;
          const end = parseDate(phase.endDate);
          if (end && today > end && phase.state !== "Completado") {
            health = "at_risk";
            healthLabel = "En Riesgo";
            status = "En Riesgo";
            break;
          }
        }
      }
    }

    projects.push({
      projectId: proj.projectId,
      name: proj.name,
      client: proj.client,
      responsible: proj.responsible,
      status,
      health,
      healthLabel,
      overallProgress,
      deliveryDate,
      phases: proj.phases.map((p) => ({
        phase: p.phase,
        state: p.state,
        progress: p.progress || 0,
        startDate: p.startDate || "",
        endDate: p.endDate || "",
        comment: p.comment || "",
        id: p.id,
      })),
    });
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a date string in DD/MM/YYYY format
 */
function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split("/");
  if (!d || !m || !y) return null;
  return new Date(+y, +m - 1, +d);
}

/**
 * Find a project by approximate name match (case-insensitive, partial)
 */
function findProjectByName(projects, searchName) {
  const q = searchName.toLowerCase().trim();
  // Exact match first
  let found = projects.find((p) => p.name.toLowerCase() === q);
  if (found) return found;
  // Partial match
  found = projects.find((p) => p.name.toLowerCase().includes(q));
  return found || null;
}

/**
 * Compute executive KPI summary from a list of projects
 */
function computeSummary(projects) {
  const total = projects.length;
  const completed = projects.filter((p) => p.health === "completed").length;
  const delayed = projects.filter((p) => p.health === "delayed").length;
  const atRisk = projects.filter((p) => p.health === "at_risk").length;
  const onTrack = projects.filter((p) => p.health === "on_track").length;
  const sla =
    total > 0 ? Math.round(((total - delayed) / total) * 100) : 100;
  const criticalProjects = projects
    .filter((p) => p.health === "delayed" || p.health === "at_risk")
    .map((p) => p.name);

  return { total, completed, onTrack, atRisk, delayed, sla, criticalProjects };
}

module.exports = { groupPhasesIntoProjects, findProjectByName, computeSummary };
