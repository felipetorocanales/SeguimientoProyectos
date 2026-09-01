/**
 * telegram.js - Telegram Bot Webhook Handler for Nexus Tracker
 *
 * Implements a streamlined, frictionless 3-step project update wizard:
 *   1. Select Project (interactive buttons)
 *   2. Select Health Indicator (🟢 Bien / 🟡 Con Riesgos / 🔴 Bloqueado)
 *   3. Record Achievements (text or skip)
 *   4. Record Blockers (text or none)
 */

const https = require("https");
const {
  groupPhasesIntoProjects,
  findProjectByName,
  computeSummary,
} = require("./projectHelpers");

const SESSIONS_COLLECTION = "telegram_sessions";

/**
 * Escapes special HTML characters in dynamic user content
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send a message back to Telegram with optional inline keyboard
 */
function sendTelegramMessage(botToken, chatId, htmlText, replyMarkup = null) {
  return new Promise((resolve, reject) => {
    let safeText = htmlText;
    if (safeText.length > 4000) {
      safeText = safeText.substring(0, 3950) + "\n\n<i>[Mensaje truncado por longitud...]</i>";
    }

    const payloadObj = {
      chat_id: chatId,
      text: safeText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    if (replyMarkup) {
      payloadObj.reply_markup = replyMarkup;
    }

    const payload = JSON.stringify(payloadObj);

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${botToken}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.error(`[Telegram API Error ${res.statusCode}]`, data);
        }
        resolve(data);
      });
    });

    req.on("error", (err) => {
      console.error("[Telegram Request Error]", err);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Answer callback query (removes loading state on button in Telegram)
 */
function answerCallbackQuery(botToken, callbackQueryId, text = "") {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text,
    });

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${botToken}/answerCallbackQuery`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });

    req.on("error", () => resolve());
    req.write(payload);
    req.end();
  });
}

/**
 * Main Webhook Handler for Telegram updates
 */
async function handleTelegramWebhook(req, res, db, collectionName, botToken) {
  try {
    const update = req.body;
    if (!update) return res.status(200).send("OK");

    // Helper to fetch all aggregated projects from Firestore
    const getProjects = async () => {
      const snapshot = await db.collection(collectionName).get();
      const phases = snapshot.docs.map((d) => d.data());
      return groupPhasesIntoProjects(phases);
    };

    // Helper for session management
    const sessionRef = (chatId) => db.collection(SESSIONS_COLLECTION).doc(String(chatId));
    const getSession = async (chatId) => {
      const doc = await sessionRef(chatId).get();
      return doc.exists ? doc.data() : null;
    };
    const clearSession = async (chatId) => {
      await sessionRef(chatId).delete();
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 1. HANDLE CALLBACK QUERY (Button Clicks)
    // ─────────────────────────────────────────────────────────────────────────
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const data = cb.data || "";

      await answerCallbackQuery(botToken, cb.id);

      // CANCEL ACTION
      if (data === "cancel_wizard") {
        await clearSession(chatId);
        await sendTelegramMessage(botToken, chatId, "❌ Actualización cancelada.");
        return res.status(200).send("OK");
      }

      // STEP 1 CLICK: PROJECT SELECTED (`proj:<projectId>`)
      if (data.startsWith("proj:")) {
        const projectId = data.replace("proj:", "");
        const projects = await getProjects();
        const project = projects.find((p) => p.projectId === projectId);

        if (!project) {
          await sendTelegramMessage(botToken, chatId, "❌ No se encontró el proyecto seleccionado.");
          return res.status(200).send("OK");
        }

        // Save session and ask for Health directly
        await sessionRef(chatId).set({
          chatId: String(chatId),
          step: "SELECT_HEALTH",
          projectId: project.projectId,
          projectName: project.name,
          updatedAt: Date.now(),
        });

        const healthButtons = [
          [{ text: "🟢 Bien (En tiempo y forma)", callback_data: "health:verde" }],
          [{ text: "🟡 Con Riesgos (Manejables)", callback_data: "health:amarillo" }],
          [{ text: "🔴 Bloqueado (Problemas / Freno)", callback_data: "health:rojo" }],
          [{ text: "❌ Cancelar", callback_data: "cancel_wizard" }],
        ];

        await sendTelegramMessage(
          botToken,
          chatId,
          `📌 Proyecto: <b>${escapeHtml(project.name)}</b>\n\n🚦 <b>¿Cuál es el estado de salud del proyecto?</b>`,
          { inline_keyboard: healthButtons }
        );
        return res.status(200).send("OK");
      }

      // STEP 2 CLICK: HEALTH SELECTED (`health:<color>`)
      if (data.startsWith("health:")) {
        const healthColor = data.replace("health:", "");
        const session = await getSession(chatId);

        if (!session || !session.projectId) {
          await sendTelegramMessage(botToken, chatId, "⚠️ Sesión expirada. Escribe /actualizar para iniciar de nuevo.");
          return res.status(200).send("OK");
        }

        // Update session
        await sessionRef(chatId).update({
          step: "AWAITING_ACHIEVEMENTS",
          healthIndicator: healthColor,
          updatedAt: Date.now(),
        });

        const skipButtons = [
          [{ text: "💬 Omitir logros", callback_data: "skip_achievements" }],
          [{ text: "❌ Cancelar", callback_data: "cancel_wizard" }],
        ];

        await sendTelegramMessage(
          botToken,
          chatId,
          `📌 Proyecto: <b>${escapeHtml(session.projectName)}</b>\n\n🏆 <b>¿Qué lograron esta semana o período?</b>\n<i>(Escribe los avances en un mensaje o presiona "Omitir logros")</i>`,
          { inline_keyboard: skipButtons }
        );
        return res.status(200).send("OK");
      }

      // STEP 3 CLICK: SKIP ACHIEVEMENTS (`skip_achievements`)
      if (data === "skip_achievements") {
        const session = await getSession(chatId);
        if (!session || !session.projectId) {
          await sendTelegramMessage(botToken, chatId, "⚠️ Sesión expirada. Escribe /actualizar para iniciar de nuevo.");
          return res.status(200).send("OK");
        }

        await sessionRef(chatId).update({
          step: "AWAITING_BLOCKERS",
          achievements: "Ninguno reportado",
          updatedAt: Date.now(),
        });

        const skipBlockButtons = [
          [{ text: "💬 Ninguno (Todo fluye)", callback_data: "skip_blockers" }],
          [{ text: "❌ Cancelar", callback_data: "cancel_wizard" }],
        ];

        await sendTelegramMessage(
          botToken,
          chatId,
          `⚠️ <b>¿Qué los está frenando o bloqueando?</b>\n<i>(Falta de respuesta del cliente, accesos pendientes, problemas técnicos, etc. O presiona "Ninguno")</i>`,
          { inline_keyboard: skipBlockButtons }
        );
        return res.status(200).send("OK");
      }

      // STEP 4 CLICK: SKIP BLOCKERS (`skip_blockers`)
      if (data === "skip_blockers") {
        const session = await getSession(chatId);
        if (!session || !session.projectId) {
          await sendTelegramMessage(botToken, chatId, "⚠️ Sesión expirada. Escribe /actualizar para iniciar de nuevo.");
          return res.status(200).send("OK");
        }

        await executeProjectUpdate(db, collectionName, session, "Ninguno", botToken, chatId);
        await clearSession(chatId);
        return res.status(200).send("OK");
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. HANDLE REGULAR TEXT MESSAGES
    // ─────────────────────────────────────────────────────────────────────────
    if (!update.message) return res.status(200).send("OK");

    const message = update.message;
    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    if (!text) return res.status(200).send("OK");

    // CANCEL COMMAND
    if (text.toLowerCase() === "/cancelar") {
      await clearSession(chatId);
      await sendTelegramMessage(botToken, chatId, "❌ Proceso de actualización cancelado.");
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /start or /ayuda ──────────────────────────────────────────
    if (text.startsWith("/start") || text.toLowerCase().includes("ayuda") || text === "/help") {
      await clearSession(chatId);
      const reply = 
`🤖 <b>Nexus Tracker Bot</b>

¡Hola! Soy tu asistente de seguimiento de proyectos.

📌 <b>Comandos disponibles:</b>

📊 <b>/resumen</b> - Ver KPIs del tablero ejecutivo
📋 <b>/proyectos</b> - Listar proyectos activos <i>(filtros: todo, completados, riesgo, retrasados)</i>
🔍 <b>/buscar &lt;nombre&gt;</b> - Consultar estado de un proyecto
✏️ <b>/actualizar</b> - Actualizar logros y bloqueos en 3 pasos`;

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /resumen ──────────────────────────────────────────────────
    if (text.startsWith("/resumen") || text.toLowerCase() === "resumen") {
      const projects = await getProjects();
      const summary = computeSummary(projects);

      const reply = 
`📊 <b>Resumen Ejecutivo - Nexus Tracker</b>

🔹 <b>Total Proyectos:</b> ${summary.total}
✅ <b>Completados:</b> ${summary.completed}
🟢 <b>A tiempo:</b> ${summary.onTrack}
⚠️ <b>En riesgo:</b> ${summary.atRisk}
🚨 <b>Retrasados:</b> ${summary.delayed}
📈 <b>Cumplimiento SLA:</b> <b>${summary.sla}%</b>

${summary.criticalProjects.length > 0 ? `🔥 <b>Proyectos en foco (${summary.criticalProjects.length}):</b>\n` + summary.criticalProjects.map(p => `• ${escapeHtml(p)}`).join("\n") : "✨ ¡No hay proyectos críticos en riesgo!"}`;

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /proyectos ────────────────────────────────────────────────
    if (text.startsWith("/proyectos") || text.toLowerCase() === "proyectos") {
      const allProjects = await getProjects();
      const arg = text.replace("/proyectos", "").trim().toLowerCase();

      let filtered = allProjects;
      let title = "📋 Proyectos Activos";

      if (arg === "todo" || arg === "todos") {
        filtered = allProjects;
        title = "📋 Todos los Proyectos";
      } else if (arg === "completados" || arg === "completado") {
        filtered = allProjects.filter((p) => p.health === "completed");
        title = "✅ Proyectos Completados";
      } else if (arg === "riesgo" || arg === "en riesgo") {
        filtered = allProjects.filter((p) => p.health === "at_risk");
        title = "⚠️ Proyectos en Riesgo";
      } else if (arg === "retrasados" || arg === "retrasado") {
        filtered = allProjects.filter((p) => p.health === "delayed");
        title = "🚨 Proyectos Retrasados";
      } else {
        filtered = allProjects.filter((p) => p.health !== "completed");
        title = "📋 Proyectos Activos";
      }

      if (filtered.length === 0) {
        await sendTelegramMessage(botToken, chatId, `📭 No hay proyectos en la categoría "<b>${escapeHtml(arg || "activos")}</b>".`);
        return res.status(200).send("OK");
      }

      let reply = `<b>${title} (${filtered.length}):</b>\n\n`;
      filtered.slice(0, 15).forEach((p) => {
        let badge = "🟢";
        if (p.health === "completed") badge = "✅";
        else if (p.health === "at_risk") badge = "⚠️";
        else if (p.health === "delayed") badge = "🚨";

        reply += `${badge} <b>${escapeHtml(p.name)}</b>\n   ├ Tiempo transcurrido: <b>${p.overallProgress}%</b> (${escapeHtml(p.healthLabel)})\n   └ Cliente: ${escapeHtml(p.client)}\n\n`;
      });

      if (filtered.length > 15) {
        reply += `<i>...y ${filtered.length - 15} proyectos más.</i>\n\n`;
      }

      reply += `💡 <i>Tip: /proyectos todo | /proyectos completados | /proyectos riesgo | /proyectos retrasados</i>`;

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /buscar <nombre> ──────────────────────────────────────────
    if (text.startsWith("/buscar")) {
      const query = text.replace("/buscar", "").trim();
      if (!query) {
        await sendTelegramMessage(botToken, chatId, "❓ Por favor escribe el nombre a buscar. Ej: <code>/buscar Algoritmo</code>");
        return res.status(200).send("OK");
      }

      const projects = await getProjects();
      const project = findProjectByName(projects, query);

      if (!project) {
        await sendTelegramMessage(botToken, chatId, `❌ No se encontró ningún proyecto que coincida con "${escapeHtml(query)}".`);
        return res.status(200).send("OK");
      }

      const reply = 
`📌 <b>Detalle de Proyecto:</b>

<b>Nombre:</b> ${escapeHtml(project.name)}
<b>Cliente:</b> ${escapeHtml(project.client)}
<b>Responsable:</b> ${escapeHtml(project.responsible || "No asignado")}
<b>Estado:</b> ${escapeHtml(project.healthLabel)} (${project.overallProgress}% tiempo transcurrido)
📅 <b>Fecha Entrega:</b> ${escapeHtml(project.deliveryDate || "No definida")}

📝 <b>Últimas Actualizaciones:</b>
${project.comment ? escapeHtml(project.comment.split("\n").slice(-4).join("\n")) : "<i>Sin comentarios registrados</i>"}`;

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /actualizar (INTERACTIVE WIZARD) ───────────────────────────
    if (text.startsWith("/actualizar") || text.toLowerCase() === "actualizar") {
      const projects = await getProjects();
      const activeProjects = projects.filter((p) => p.health !== "completed");

      if (activeProjects.length === 0) {
        await sendTelegramMessage(botToken, chatId, "📭 No hay proyectos activos para actualizar.");
        return res.status(200).send("OK");
      }

      // Generate buttons for active projects (1 per row)
      const projectButtons = activeProjects.map((p) => {
        let badge = "🟢";
        if (p.health === "at_risk") badge = "⚠️";
        else if (p.health === "delayed") badge = "🚨";
        return [
          {
            text: `${badge} ${p.name} (${p.overallProgress}%)`,
            callback_data: `proj:${p.projectId}`,
          },
        ];
      });
      projectButtons.push([{ text: "❌ Cancelar", callback_data: "cancel_wizard" }]);

      await sessionRef(chatId).set({
        chatId: String(chatId),
        step: "SELECT_PROJECT",
        updatedAt: Date.now(),
      });

      await sendTelegramMessage(
        botToken,
        chatId,
        "📌 <b>¿Qué proyecto deseas actualizar?</b>\n<i>Selecciona uno de la lista:</i>",
        { inline_keyboard: projectButtons }
      );
      return res.status(200).send("OK");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. CHECK ACTIVE SESSION FOR STEP-BY-STEP TEXT INPUT
    // ─────────────────────────────────────────────────────────────────────────
    const session = await getSession(chatId);

    if (session) {
      // IF WAITING FOR ACHIEVEMENTS TEXT
      if (session.step === "AWAITING_ACHIEVEMENTS") {
        const achievements = (text.toLowerCase() === "omitir" || text.toLowerCase() === "nada") ? "Ninguno reportado" : text;
        
        await sessionRef(chatId).update({
          step: "AWAITING_BLOCKERS",
          achievements: achievements,
          updatedAt: Date.now(),
        });

        const skipBlockButtons = [
          [{ text: "💬 Ninguno (Todo fluye)", callback_data: "skip_blockers" }],
          [{ text: "❌ Cancelar", callback_data: "cancel_wizard" }],
        ];

        await sendTelegramMessage(
          botToken,
          chatId,
          `⚠️ <b>¿Qué los está frenando o bloqueando?</b>\n<i>(Falta de respuesta, accesos pendientes, problemas técnicos, etc. O presiona "Ninguno")</i>`,
          { inline_keyboard: skipBlockButtons }
        );
        return res.status(200).send("OK");
      }

      // IF WAITING FOR BLOCKERS TEXT
      if (session.step === "AWAITING_BLOCKERS") {
        const blockers = (text.toLowerCase() === "omitir" || text.toLowerCase() === "nada" || text.toLowerCase() === "ninguno") ? "Ninguno" : text;
        await executeProjectUpdate(db, collectionName, session, blockers, botToken, chatId);
        await clearSession(chatId);
        return res.status(200).send("OK");
      }
    }

    // Default response for unhandled text
    await sendTelegramMessage(botToken, chatId, "🤔 No entendí ese comando. Escribe <b>/ayuda</b> o <b>/actualizar</b> para ver las opciones.");
    return res.status(200).send("OK");

  } catch (err) {
    console.error("[handleTelegramWebhook]", err);
    return res.status(200).send("OK");
  }
}

/**
 * Helper to get short date in DD/MM/YY format (Chile timezone)
 */
function getChileDateShort() {
  const now = new Date();
  const options = { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", year: "2-digit" };
  const parts = new Intl.DateTimeFormat("es-CL", options).formatToParts(now);
  const day = parts.find(p => p.type === "day").value;
  const month = parts.find(p => p.type === "month").value;
  const year = parts.find(p => p.type === "year").value;
  return `${day}/${month}/${year}`;
}

/**
 * Execute the project update in Firestore and send final confirmation
 */
async function executeProjectUpdate(db, collectionName, session, blockersText, botToken, chatId) {
  const { projectName, projectId, healthIndicator, achievements } = session;

  const snapshot = await db.collection(collectionName).get();
  const allDocs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Find all matching docs for this project (or the single project doc)
  const matchingDocs = allDocs.filter(
    (p) =>
      p.projectId === projectId ||
      (p.project || "").toLowerCase() === (projectName || "").toLowerCase() ||
      (p.name || "").toLowerCase() === (projectName || "").toLowerCase()
  );

  if (matchingDocs.length === 0) {
    await sendTelegramMessage(botToken, chatId, "❌ Error al guardar: No se encontró el proyecto en la base de datos.");
    return;
  }

  // Format new structured update log
  const todayStr = getChileDateShort();
  let healthIcon = "";
  if (healthIndicator === "verde") healthIcon = "🟢 Bien";
  else if (healthIndicator === "amarillo") healthIcon = "🟡 Con Riesgos";
  else if (healthIndicator === "rojo") healthIcon = "🔴 Bloqueado";

  const commentParts = [];
  if (healthIcon) commentParts.push(`Salud: ${healthIcon}`);
  if (achievements && achievements !== "Ninguno reportado") commentParts.push(`Logros: ${achievements.trim()}`);
  if (blockersText && blockersText !== "Ninguno" && blockersText !== "") commentParts.push(`Bloqueos: ${blockersText.trim()}`);

  const addedEntry = `${todayStr}: ${commentParts.join(" | ")}`;

  // Update docs in Firestore
  const updatePromises = matchingDocs.map(async (docData) => {
    const existingComment = (docData.comment || docData.comments || "").trim();
    const newComment = existingComment.length > 0 ? `${existingComment}\n${addedEntry}` : addedEntry;

    await db.collection(collectionName).doc(docData.id).update({
      comment: newComment,
      lastModified: Date.now(),
    });
  });

  await Promise.all(updatePromises);

  const confirmation = 
`✅ <b>¡Proyecto Actualizado con Éxito!</b>

📌 <b>Proyecto:</b> ${escapeHtml(projectName)}
🚦 <b>Estado Reportado:</b> ${healthIcon || "🟢"}
🏆 <b>Logros:</b> ${escapeHtml(achievements && achievements !== "Ninguno reportado" ? achievements : "Sin novedades")}
⚠️ <b>Bloqueos:</b> ${escapeHtml(blockersText && blockersText !== "Ninguno" ? blockersText : "Ninguno")}`;

  await sendTelegramMessage(botToken, chatId, confirmation);
}

module.exports = { handleTelegramWebhook };
