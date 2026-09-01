/**
 * telegram.js - Telegram Bot Webhook Handler for Nexus Tracker
 *
 * Implements an interactive multi-step wizard using Telegram Inline Keyboards
 * and Firestore session state for updating projects step-by-step:
 *   1. Select Project (interactive buttons)
 *   2. Select Phase (interactive buttons)
 *   3. Select/Enter Percentage (quick buttons or custom number)
 *   4. Leave Comment (type message or click "Sin comentario")
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

        // Save session
        await sessionRef(chatId).set({
          chatId: String(chatId),
          step: "SELECT_PHASE",
          projectId: project.projectId,
          projectName: project.name,
          updatedAt: Date.now(),
        });

        // Generate phase buttons
        const phaseButtons = project.phases.map((p) => [
          {
            text: `${p.state === "Completado" ? "✅" : "🔹"} ${p.phase} (${p.progress}%)`,
            callback_data: `phase:${p.phase}`,
          },
        ]);
        phaseButtons.push([{ text: "❌ Cancelar", callback_data: "cancel_wizard" }]);

        await sendTelegramMessage(
          botToken,
          chatId,
          `📌 Proyecto seleccionador: <b>${escapeHtml(project.name)}</b>\n\n¿Qué fase deseas actualizar?`,
          { inline_keyboard: phaseButtons }
        );
        return res.status(200).send("OK");
      }

      // STEP 2 CLICK: PHASE SELECTED (`phase:<phaseName>`)
      if (data.startsWith("phase:")) {
        const phaseName = data.replace("phase:", "");
        const session = await getSession(chatId);

        if (!session || !session.projectId) {
          await sendTelegramMessage(botToken, chatId, "⚠️ Sesión expirada. Escribe /actualizar para iniciar de nuevo.");
          return res.status(200).send("OK");
        }

        // Update session
        await sessionRef(chatId).update({
          step: "AWAITING_PROGRESS",
          phaseName: phaseName,
          updatedAt: Date.now(),
        });

        // Quick percentage buttons
        const pctButtons = [
          [
            { text: "0%", callback_data: "pct:0" },
            { text: "25%", callback_data: "pct:25" },
            { text: "50%", callback_data: "pct:50" },
            { text: "75%", callback_data: "pct:75" },
            { text: "100%", callback_data: "pct:100" },
          ],
          [{ text: "❌ Cancelar", callback_data: "cancel_wizard" }],
        ];

        await sendTelegramMessage(
          botToken,
          chatId,
          `📌 Proyecto: <b>${escapeHtml(session.projectName)}</b>\n🔹 Fase: <b>${escapeHtml(phaseName)}</b>\n\n📊 ¿Qué porcentaje de avance tiene esta fase?\n<i>(Selecciona una opción o escribe un número de 0 a 100 en un mensaje)</i>`,
          { inline_keyboard: pctButtons }
        );
        return res.status(200).send("OK");
      }

      // STEP 3 CLICK: PERCENTAGE SELECTED (`pct:<number>`)
      if (data.startsWith("pct:")) {
        const pctNum = parseInt(data.replace("pct:", ""), 10);
        const session = await getSession(chatId);

        if (!session || !session.projectId || !session.phaseName) {
          await sendTelegramMessage(botToken, chatId, "⚠️ Sesión expirada. Escribe /actualizar para iniciar de nuevo.");
          return res.status(200).send("OK");
        }

        // Update session
        await sessionRef(chatId).update({
          step: "AWAITING_COMMENT",
          progress: pctNum,
          updatedAt: Date.now(),
        });

        const commentButtons = [
          [{ text: "💬 Sin comentario", callback_data: "skip_comment" }],
          [{ text: "❌ Cancelar", callback_data: "cancel_wizard" }],
        ];

        await sendTelegramMessage(
          botToken,
          chatId,
          `📌 Proyecto: <b>${escapeHtml(session.projectName)}</b>\n🔹 Fase: <b>${escapeHtml(session.phaseName)}</b> (${pctNum}%)\n\n📝 ¿Qué mensaje o nota quieres dejar?\n<i>(Escribe tu comentario en un mensaje o presiona "Sin comentario")</i>`,
          { inline_keyboard: commentButtons }
        );
        return res.status(200).send("OK");
      }

      // STEP 4 CLICK: SKIP COMMENT (`skip_comment`)
      if (data === "skip_comment") {
        const session = await getSession(chatId);
        if (!session || !session.projectId || !session.phaseName) {
          await sendTelegramMessage(botToken, chatId, "⚠️ Sesión expirada. Escribe /actualizar para iniciar de nuevo.");
          return res.status(200).send("OK");
        }

        await executePhaseUpdate(db, collectionName, session, "", botToken, chatId);
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
✏️ <b>/actualizar</b> - Iniciar asistente interactivo paso a paso`;

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

${summary.criticalProjects.length > 0 ? `🔥 <b>Proyectos críticos (${summary.criticalProjects.length}):</b>\n` + summary.criticalProjects.map(p => `• ${escapeHtml(p)}`).join("\n") : "✨ ¡No hay proyectos críticos en riesgo!"}`;

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
        // Default: only active projects (exclude completed)
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

        reply += `${badge} <b>${escapeHtml(p.name)}</b>\n   ├ Progreso: <b>${p.overallProgress}%</b> (${escapeHtml(p.healthLabel)})\n   └ Cliente: ${escapeHtml(p.client)}\n\n`;
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

      let phasesText = project.phases.map(p => {
        let st = p.state === "Completado" ? "✅" : (p.state === "En curso" ? "🔄" : "⏳");
        const cleanComment = p.comment ? ` <i>("${escapeHtml(p.comment)}")</i>` : "";
        return `   • <b>${escapeHtml(p.phase)}:</b> ${p.progress}% ${st}${cleanComment}`;
      }).join("\n");

      const reply = 
`📌 <b>Detalle de Proyecto:</b>

<b>Nombre:</b> ${escapeHtml(project.name)}
<b>Cliente:</b> ${escapeHtml(project.client)}
<b>Responsable:</b> ${escapeHtml(project.responsible || "No asignado")}
<b>Estado Global:</b> ${escapeHtml(project.healthLabel)} (${project.overallProgress}%)
📅 <b>Fecha Entrega:</b> ${escapeHtml(project.deliveryDate || "No definida")}

<b>Fases:</b>
${phasesText}`;

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /actualizar (INTERACTIVE WIZARD START OR DIRECT LINE) ───────
    if (text.startsWith("/actualizar") || text.toLowerCase() === "actualizar") {
      const raw = text.replace("/actualizar", "").trim();

      // Check if user provided inline pipeline syntax: `/actualizar Proyecto | Fase | 80 | Comentario`
      if (raw.includes("|")) {
        const parts = raw.split("|").map(p => p.trim());
        if (parts.length >= 3) {
          const [projectNameSearch, phaseSearch, progressStr, commentStr] = parts;
          const newProgress = parseInt(progressStr, 10);
          if (!isNaN(newProgress) && newProgress >= 0 && newProgress <= 100) {
            const projects = await getProjects();
            const project = findProjectByName(projects, projectNameSearch);
            if (project) {
              const matchingPhase = project.phases.find(p => p.phase.toLowerCase().includes(phaseSearch.toLowerCase()));
              if (matchingPhase) {
                await executePhaseUpdate(db, collectionName, { projectName: project.name, projectId: project.projectId, phaseName: matchingPhase.phase, progress: newProgress }, commentStr || "", botToken, chatId);
                return res.status(200).send("OK");
              }
            }
          }
        }
      }

      // INTERACTIVE WIZARD FLOW:
      // Fetch ACTIVE projects
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

      // Save initial wizard session state
      await sessionRef(chatId).set({
        chatId: String(chatId),
        step: "SELECT_PROJECT",
        updatedAt: Date.now(),
      });

      await sendTelegramMessage(
        botToken,
        chatId,
        "📌 <b>¿Qué proyecto deseas actualizar?</b>\n<i>Selecciona uno de la lista a continuación:</i>",
        { inline_keyboard: projectButtons }
      );
      return res.status(200).send("OK");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. CHECK ACTIVE SESSION FOR STEP-BY-STEP TEXT INPUT
    // ─────────────────────────────────────────────────────────────────────────
    const session = await getSession(chatId);

    if (session) {
      // IF WAITING FOR PROGRESS NUMBER AS TEXT
      if (session.step === "AWAITING_PROGRESS") {
        const num = parseInt(text, 10);
        if (isNaN(num) || num < 0 || num > 100) {
          await sendTelegramMessage(botToken, chatId, "❌ El porcentaje debe ser un número entero entre 0 y 100. Inténtalo de nuevo:");
          return res.status(200).send("OK");
        }

        await sessionRef(chatId).update({
          step: "AWAITING_COMMENT",
          progress: num,
          updatedAt: Date.now(),
        });

        const commentButtons = [
          [{ text: "💬 Sin comentario", callback_data: "skip_comment" }],
          [{ text: "❌ Cancelar", callback_data: "cancel_wizard" }],
        ];

        await sendTelegramMessage(
          botToken,
          chatId,
          `📌 Proyecto: <b>${escapeHtml(session.projectName)}</b>\n🔹 Fase: <b>${escapeHtml(session.phaseName)}</b> (${num}%)\n\n📝 ¿Qué mensaje o comentario deseas dejar?\n<i>(Escribe tu comentario en un mensaje o presiona "Sin comentario")</i>`,
          { inline_keyboard: commentButtons }
        );
        return res.status(200).send("OK");
      }

      // IF WAITING FOR COMMENT TEXT
      if (session.step === "AWAITING_COMMENT") {
        const comment = (text === "/omitir" || text.toLowerCase() === "sin comentario") ? "" : text;
        await executePhaseUpdate(db, collectionName, session, comment, botToken, chatId);
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
 * Execute the phase update in Firestore and send final confirmation
 */
async function executePhaseUpdate(db, collectionName, session, commentText, botToken, chatId) {
  const { projectName, projectId, phaseName, progress } = session;

  const snapshot = await db.collection(collectionName).get();
  const phases = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

  const matchingPhase = phases.find(
    (p) =>
      (p.projectId === projectId || (p.project || "").toLowerCase() === (projectName || "").toLowerCase()) &&
      (p.phase || "").toLowerCase().includes((phaseName || "").toLowerCase())
  );

  if (!matchingPhase) {
    await sendTelegramMessage(botToken, chatId, "❌ Error al guardar: No se encontró la fase correspondiente en la base de datos.");
    return;
  }

  const updates = {
    progress: progress,
    lastModified: Date.now(),
  };

  if (progress === 100) updates.state = "Completado";
  else if (progress === 0) updates.state = "No iniciado";
  else updates.state = "En curso";

  if (commentText) updates.comment = commentText;

  await db.collection(collectionName).doc(matchingPhase.id).update(updates);

  const confirmation = 
`✅ <b>¡Proyecto Actualizado con Éxito!</b>

📌 <b>Proyecto:</b> ${escapeHtml(projectName)}
🔹 <b>Fase:</b> ${escapeHtml(phaseName)}
📊 <b>Nuevo Progreso:</b> ${progress}%
📝 <b>Comentario:</b> ${escapeHtml(commentText || "Sin comentarios")}`;

  await sendTelegramMessage(botToken, chatId, confirmation);
}

module.exports = { handleTelegramWebhook };
