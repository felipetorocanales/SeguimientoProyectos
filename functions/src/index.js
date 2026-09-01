/**
 * index.js - Firebase Cloud Functions API for Nexus Tracker
 *
 * Exposes a REST API that Teams (Power Automate) can call to
 * query and update project data in Firestore.
 *
 * Base URL after deploy:
 *   https://us-central1-nexus-tracker-b7a75.cloudfunctions.net/api
 *
 * All endpoints require header: X-API-Key: <your secret key>
 *
 * Endpoints:
 *   GET  /projects              → List all active projects
 *   GET  /projects/:name        → Find a project by name (partial match)
 *   GET  /my-projects/:email    → Projects where responsible matches email
 *   PATCH /projects/:name/phase/:phase → Update a phase's progress/state/comment
 *   GET  /summary               → Executive KPI summary
 */

const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");
const { apiKeyMiddleware } = require("./auth");
const { handleTelegramWebhook } = require("./telegram");
const {
  groupPhasesIntoProjects,
  findProjectByName,
  computeSummary,
} = require("./projectHelpers");

// ─── Init ────────────────────────────────────────────────────────────────────
admin.initializeApp();
const db = admin.firestore();
const COLLECTION = "phases";

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS - allow Power Automate and Teams to call the API
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// Telegram Webhook route (must be before API key middleware since Telegram sends unauthenticated POSTs)
app.post("/telegram-webhook", (req, res) => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    console.error("[Telegram] TELEGRAM_BOT_TOKEN environment variable not set");
    return res.status(500).send("Telegram token not configured");
  }
  return handleTelegramWebhook(req, res, db, COLLECTION, token);
});

// Apply API Key auth to all remaining routes
app.use(apiKeyMiddleware);

// ─── Helper: load all active phases from Firestore ───────────────────────────
async function getAllProjects() {
  const snapshot = await db.collection(COLLECTION).get();
  const phases = snapshot.docs.map((d) => d.data());
  return groupPhasesIntoProjects(phases);
}

// ─── GET /projects ────────────────────────────────────────────────────────────
// Returns all active projects (summarized, no phase details)
app.get("/projects", async (req, res) => {
  try {
    const projects = await getAllProjects();
    const simplified = projects.map(({ projectId, name, client, responsible, status, health, healthLabel, overallProgress, deliveryDate }) => ({
      projectId, name, client, responsible, status, health, healthLabel, overallProgress, deliveryDate
    }));
    res.json({ success: true, count: simplified.length, projects: simplified });
  } catch (err) {
    console.error("[GET /projects]", err);
    res.status(500).json({ error: "Error al obtener proyectos", detail: err.message });
  }
});

// ─── GET /projects/:name ─────────────────────────────────────────────────────
// Find a specific project by partial name match, includes phase details
app.get("/projects/:name", async (req, res) => {
  try {
    const projects = await getAllProjects();
    const project = findProjectByName(projects, req.params.name);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: `No se encontró ningún proyecto con el nombre "${req.params.name}".`
      });
    }
    res.json({ success: true, project });
  } catch (err) {
    console.error("[GET /projects/:name]", err);
    res.status(500).json({ error: "Error al buscar proyecto", detail: err.message });
  }
});

// ─── GET /my-projects/:email ──────────────────────────────────────────────────
// Returns projects where the responsible field matches the given email
app.get("/my-projects/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase().trim();
    const projects = await getAllProjects();
    const mine = projects.filter(
      (p) => (p.responsible || "").toLowerCase().trim() === email
    );
    res.json({
      success: true,
      email,
      count: mine.length,
      projects: mine.map(({ name, client, status, healthLabel, overallProgress, deliveryDate }) => ({
        name, client, status, healthLabel, overallProgress, deliveryDate
      }))
    });
  } catch (err) {
    console.error("[GET /my-projects/:email]", err);
    res.status(500).json({ error: "Error al obtener tus proyectos", detail: err.message });
  }
});

// ─── PATCH /projects/:name/phase/:phase ───────────────────────────────────────
// Update a specific phase of a project
// Body: { progress: number, state: string, comment: string }
app.patch("/projects/:name/phase/:phase", async (req, res) => {
  try {
    const projects = await getAllProjects();
    const project = findProjectByName(projects, req.params.name);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: `No se encontró ningún proyecto con el nombre "${req.params.name}".`
      });
    }

    // Find matching phase
    const phaseNameSearch = req.params.phase.toLowerCase().trim();
    const matchingPhase = project.phases.find(
      (p) => p.phase.toLowerCase().includes(phaseNameSearch)
    );

    if (!matchingPhase) {
      return res.status(404).json({
        success: false,
        message: `No se encontró la fase "${req.params.phase}" en el proyecto "${project.name}". Fases disponibles: ${project.phases.map(p => p.phase).join(", ")}.`
      });
    }

    // Validate and prepare updates
    const updates = {};
    const { progress, state, comment } = req.body;

    if (progress !== undefined) {
      const p = parseInt(progress, 10);
      if (isNaN(p) || p < 0 || p > 100) {
        return res.status(400).json({ success: false, message: "El progreso debe ser un número entre 0 y 100." });
      }
      updates.progress = p;
      // Auto-set state based on progress if not explicitly provided
      if (!state) {
        if (p === 0) updates.state = "No iniciado";
        else if (p === 100) updates.state = "Completado";
        else updates.state = "En curso";
      }
    }

    if (state !== undefined) {
      const validStates = ["No iniciado", "En curso", "Completado", "Bloqueado"];
      if (!validStates.includes(state)) {
        return res.status(400).json({
          success: false,
          message: `Estado inválido. Usa uno de: ${validStates.join(", ")}.`
        });
      }
      updates.state = state;
    }

    if (comment !== undefined) {
      updates.comment = String(comment).trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No se proporcionaron campos para actualizar (progress, state, comment)." });
    }

    // Write to Firestore
    const phaseRef = db.collection(COLLECTION).doc(matchingPhase.id);
    await phaseRef.update({ ...updates, lastModified: Date.now() });

    res.json({
      success: true,
      message: `✅ Fase "${matchingPhase.phase}" del proyecto "${project.name}" actualizada correctamente.`,
      projectName: project.name,
      phase: matchingPhase.phase,
      updates
    });
  } catch (err) {
    console.error("[PATCH /projects/:name/phase/:phase]", err);
    res.status(500).json({ error: "Error al actualizar la fase", detail: err.message });
  }
});

// ─── GET /summary ─────────────────────────────────────────────────────────────
// Returns executive KPI summary (for Teams channel of managers)
app.get("/summary", async (req, res) => {
  try {
    const clientFilter = req.query.client; // optional ?client=Nexus
    let projects = await getAllProjects();
    if (clientFilter) {
      projects = projects.filter(
        (p) => p.client.toLowerCase() === clientFilter.toLowerCase()
      );
    }
    const summary = computeSummary(projects);
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error("[GET /summary]", err);
    res.status(500).json({ error: "Error al generar resumen ejecutivo", detail: err.message });
  }
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: "Ruta no encontrada",
    availableEndpoints: [
      "GET /projects",
      "GET /projects/:name",
      "GET /my-projects/:email",
      "PATCH /projects/:name/phase/:phase",
      "GET /summary"
    ]
  });
});

// ─── Export as Firebase Function ──────────────────────────────────────────────
exports.api = onRequest(
  {
    secrets: ["NEXUS_API_KEY", "TELEGRAM_BOT_TOKEN"],
    invoker: "public",
  },
  app
);
