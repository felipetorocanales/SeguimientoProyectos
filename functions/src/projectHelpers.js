/**
 * projectHelpers.js - Business logic for aggregating and calculating project status & KPIs
 *
 * Supports both modern single-cycle projects and legacy multi-phase projects.
 * Calculates automatic calendar-based progress and health metrics.
 */

/**
 * Parse a date string in DD/MM/YYYY or YYYY-MM-DD format
 */
function parseDate(str) {
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
 * Calculates automatic progress based on elapsed time vs total timeframe (0 to 100%),
 * accounting for active pauses and historical pause intervals.
 */
function calculateTimeProgress(startDateStr, deliveryDateStr, pauseHistory = []) {
  const start = parseDate(startDateStr);
  const end = parseDate(deliveryDateStr);
  if (!start || !end || end <= start) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (today < start) return 0;
  if (today >= end) return 100;

  const totalTime = end.getTime() - start.getTime();
  if (totalTime <= 0) return 0;

  // Process pauses in chronological order
  const validPauses = (Array.isArray(pauseHistory) ? pauseHistory : [])
    .map(p => {
      const pStart = parseDate(p.startDate);
      const pEnd = p.endDate ? parseDate(p.endDate) : null;
      return { start: pStart, end: pEnd, isClosed: !!pEnd };
    })
    .filter(p => p.start !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const activePause = validPauses.find(p => !p.isClosed);

  if (activePause) {
    // CURRENTLY IN ACTIVE PAUSE:
    // Work halted when activePause started.
    // Progress remains frozen at the accumulated active work up to activePause.start,
    // evaluated against the extended deadline (end).
    const pauseStart = activePause.start;
    let activeWorkMs = 0;
    let currentCursor = start.getTime();

    for (const p of validPauses) {
      if (p === activePause) break;
      const pStartTime = Math.max(currentCursor, p.start.getTime());
      const pEndTime = p.end ? p.end.getTime() : pStartTime;
      if (pStartTime > currentCursor) {
        activeWorkMs += (pStartTime - currentCursor);
      }
      currentCursor = Math.max(currentCursor, pEndTime);
    }

    if (pauseStart.getTime() > currentCursor) {
      activeWorkMs += (pauseStart.getTime() - currentCursor);
    }

    return Math.min(100, Math.max(0, Math.round((activeWorkMs / totalTime) * 100)));
  }

  // NOT IN ACTIVE PAUSE:
  if (validPauses.length === 0) {
    const elapsedTime = today.getTime() - start.getTime();
    return Math.min(100, Math.max(0, Math.round((elapsedTime / totalTime) * 100)));
  }

  // HAS FINISHED PAUSES:
  // Calculate total active work performed up to the last pause resume date,
  // then interpolate remaining progress from last resume date to delivery date.
  const lastPause = validPauses[validPauses.length - 1];
  const lastResumeTime = lastPause.end ? lastPause.end.getTime() : today.getTime();

  let activeWorkBeforeLastResumeMs = 0;
  let cursor = start.getTime();
  for (const p of validPauses) {
    const pStartTime = Math.max(cursor, p.start.getTime());
    const pEndTime = p.end ? p.end.getTime() : pStartTime;
    if (pStartTime > cursor) {
      activeWorkBeforeLastResumeMs += (pStartTime - cursor);
    }
    cursor = Math.max(cursor, pEndTime);
  }

  const progressAtResume = (activeWorkBeforeLastResumeMs / totalTime) * 100;

  if (today.getTime() <= lastResumeTime) {
    return Math.min(100, Math.max(0, Math.round(progressAtResume)));
  }

  const remainingSpanMs = end.getTime() - lastResumeTime;
  if (remainingSpanMs <= 0) return 100;

  const elapsedSinceResumeMs = today.getTime() - lastResumeTime;
  const fraction = Math.min(1, Math.max(0, elapsedSinceResumeMs / remainingSpanMs));
  const currentProgress = progressAtResume + fraction * (100 - progressAtResume);

  return Math.min(100, Math.max(0, Math.round(currentProgress)));
}

/**
 * Groups an array of raw documents from Firestore into unified project models.
 * @param {Array} items - Raw docs from Firestore collection "phases"
 * @returns {Array} - Aggregated project objects
 */
function groupPhasesIntoProjects(items) {
  const projectMap = new Map();

  // Prefer exclusively single-cycle project documents (new architecture & migrated)
  const singleCycleItems = items.filter(i => (i.isSingleCycle === true || i.phase === "Ciclo Principal") && !i.isArchived);
  const itemsToProcess = singleCycleItems.length > 0 ? singleCycleItems : items;

  for (const item of itemsToProcess) {
    if (item.isArchived) continue;

    const projName = (item.project || item.name || "").replace(/\s+/g, " ").trim();
    const key = (item.isSingleCycle === true || item.phase === "Ciclo Principal")
      ? (item.id || projName)
      : (item.projectId || projName || item.id);

    if (!projectMap.has(key)) {
      projectMap.set(key, {
        projectId: item.id || key,
        name: projName,
        client: item.client || "General",
        responsible: item.responsible || "",
        startDate: item.startDate || "",
        deliveryDate: item.deliveryDate || item.endDate || "",
        state: item.state || "En curso",
        inferredPhase: item.inferredPhase || "En curso",
        comments: item.comments || item.comment || "",
        phases: [],
        isSingleCycle: item.isSingleCycle || false,
      });
    }

    const proj = projectMap.get(key);
    proj.phases.push(item);
    if (item.responsible && !proj.responsible) {
      proj.responsible = item.responsible;
    }
  }

  const projects = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const proj of projectMap.values()) {
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

    // Pauses evaluation
    const pauseHistories = proj.phases.flatMap(p => Array.isArray(p.pauseHistory) ? p.pauseHistory : []);
    proj.pauseHistory = pauseHistories;
    proj.isPaused = proj.phases.some(p => p.isPaused === true || p.state === 'Pausado');
    
    // Find active pause
    let activePauseDays = 0;
    const activePause = proj.pauseHistory.find(ph => !ph.endDate);
    if (activePause) {
      proj.isPaused = true;
      const startPauseDate = parseDate(activePause.startDate);
      if (startPauseDate) {
        activePauseDays = Math.max(0, Math.round((today.getTime() - startPauseDate.getTime()) / (1000 * 60 * 60 * 24)));
      }
    }
    proj.activePauseDays = activePauseDays;

    let finishedPausedDays = 0;
    proj.pauseHistory.forEach(ph => {
      if (ph.endDate) {
        if (ph.days !== undefined) {
          finishedPausedDays += Number(ph.days);
        } else {
          const sDate = parseDate(ph.startDate);
          const eDate = parseDate(ph.endDate);
          if (sDate && eDate) {
            finishedPausedDays += Math.max(0, Math.round((eDate.getTime() - sDate.getTime()) / (1000 * 60 * 60 * 24)));
          }
        }
      }
    });
    proj.totalPausedDays = finishedPausedDays + activePauseDays;

    if (activePauseDays > 0 && proj.deliveryDate) {
      const baseDelObj = parseDate(proj.deliveryDate);
      if (baseDelObj) {
        const dynamicDelObj = new Date(baseDelObj);
        dynamicDelObj.setDate(dynamicDelObj.getDate() + activePauseDays);
        proj.deliveryDate = `${String(dynamicDelObj.getDate()).padStart(2, '0')}/${String(dynamicDelObj.getMonth() + 1).padStart(2, '0')}/${dynamicDelObj.getFullYear()}`;
      }
    }

    const isCompleted = !proj.isPaused && (proj.state === "Completado" || proj.state === "Finalizado" || 
      (proj.phases.length > 0 && proj.phases.every(p => p.state === "Completado" || p.state === "Finalizado")));

    // Calculate automatic time-based progress
    let timeProgress = calculateTimeProgress(proj.startDate, proj.deliveryDate, proj.pauseHistory);
    if (isCompleted) {
      timeProgress = 100;
    }

    // Real progress
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
    realProgress = Math.min(100, Math.max(0, Math.round(realProgress)));
    const overallProgress = realProgress;
    const progressGap = timeProgress - realProgress;

    // Health & Status determination
    let health = "on_track";
    let healthLabel = "A tiempo";
    let status = proj.isPaused ? "Pausado" : (isCompleted ? "Completado" : "En curso");

    const deliveryEnd = parseDate(proj.deliveryDate);

    if (proj.isPaused) {
      health = "paused";
      healthLabel = "En Pausa";
    } else if (isCompleted) {
      health = "completed";
      healthLabel = "Completado";
    } else if (deliveryEnd && today > deliveryEnd) {
      health = "delayed";
      healthLabel = "Retrasado";
      status = "Retrasado";
    } else if (deliveryEnd) {
      const diffTime = deliveryEnd.getTime() - today.getTime();
      const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // If less than 7 days remaining and real progress < 75% or with blockers
      const allComments = proj.phases.map(p => p.comment || "").join(" ") + " " + (typeof proj.comments === "string" ? proj.comments : "");
      if (allComments.includes("🔴") || allComments.toLowerCase().includes("bloqueado")) {
        health = "at_risk";
        healthLabel = "En Riesgo";
        status = "En Riesgo";
      } else if (daysRemaining <= 7 && realProgress < 75) {
        health = "at_risk";
        healthLabel = "En Riesgo";
        status = "En Riesgo";
      } else if (progressGap >= 25 && timeProgress > 40) {
        health = "at_risk";
        healthLabel = "En Riesgo";
        status = "En Riesgo";
      }
    }

    // Combine comments history into chronological view
    const combinedComments = proj.phases
      .map(p => p.comment)
      .filter(Boolean)
      .join("\n");

    // Determine immutable originalDeliveryDate
    const itemWithOrig = proj.phases.find(p => p.originalDeliveryDate);
    const originalDeliveryDate = itemWithOrig?.originalDeliveryDate || proj.phases[0]?.originalDeliveryDate || proj.deliveryDate;
    
    let postponedDays = 0;
    const origDateObj = parseDate(originalDeliveryDate);
    if (origDateObj && deliveryEnd && deliveryEnd > origDateObj) {
      const diffMs = deliveryEnd.getTime() - origDateObj.getTime();
      postponedDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    }

    projects.push({
      projectId: proj.projectId,
      name: proj.name,
      client: proj.client,
      responsible: proj.responsible,
      startDate: proj.startDate,
      deliveryDate: proj.deliveryDate,
      originalDeliveryDate,
      postponedDays,
      status,
      health,
      healthLabel,
      timeProgress,
      realProgress,
      progressGap,
      overallProgress,
      inferredPhase: proj.inferredPhase || (isCompleted ? "Completado" : "En curso"),
      comment: combinedComments || (typeof proj.comments === "string" ? proj.comments : ""),
      phases: proj.phases.map(p => ({
        phase: p.phase || "Ciclo Principal",
        state: p.state || "En curso",
        progress: p.progress !== undefined ? p.progress : realProgress,
        realProgress: p.realProgress !== undefined ? p.realProgress : realProgress,
        startDate: p.startDate || proj.startDate,
        endDate: p.endDate || proj.deliveryDate,
        originalDeliveryDate: p.originalDeliveryDate || originalDeliveryDate,
        comment: p.comment || "",
        id: p.id,
      })),
    });
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a project by approximate name match (case-insensitive, partial)
 */
function findProjectByName(projects, searchName) {
  const q = searchName.toLowerCase().trim();
  let found = projects.find((p) => p.name.toLowerCase() === q);
  if (found) return found;
  found = projects.find((p) => p.name.toLowerCase().includes(q));
  return found || null;
}

/**
 * Compute executive KPI summary from a list of projects
 */
function computeSummary(projects) {
  const total = projects.length;
  const completed = projects.filter((p) => p.health === "completed").length;
  const paused = projects.filter((p) => p.health === "paused" || p.isPaused).length;
  const delayed = projects.filter((p) => p.health === "delayed").length;
  const atRisk = projects.filter((p) => p.health === "at_risk").length;
  const onTrack = projects.filter((p) => p.health === "on_track").length;
  const inProgress = total - completed - paused;
  const sla = total > 0 ? Math.round(((total - delayed) / total) * 100) : 100;
  const criticalProjects = projects
    .filter((p) => p.health === "delayed" || p.health === "at_risk")
    .map((p) => p.name);

  return { total, inProgress, paused, completed, onTrack, atRisk, delayed, sla, criticalProjects };
}

module.exports = {
  parseDate,
  calculateTimeProgress,
  groupPhasesIntoProjects,
  findProjectByName,
  computeSummary,
};
