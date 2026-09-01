/**
 * telegram.js - Telegram Bot Webhook Handler for Nexus Tracker
 *
 * Receives updates from Telegram and replies using HTML formatting for high stability.
 */

const https = require("https");
const {
  groupPhasesIntoProjects,
  findProjectByName,
  computeSummary,
} = require("./projectHelpers");

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
 * Send a message back to Telegram
 */
function sendTelegramMessage(botToken, chatId, htmlText) {
  return new Promise((resolve, reject) => {
    // Truncate if exceeds Telegram 4096 character limit
    let safeText = htmlText;
    if (safeText.length > 4000) {
      safeText = safeText.substring(0, 3950) + "\n\n<i>[Mensaje truncado por longitud...]</i>";
    }

    const payload = JSON.stringify({
      chat_id: chatId,
      text: safeText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

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
 * Main Webhook Handler for Telegram updates
 */
async function handleTelegramWebhook(req, res, db, collectionName, botToken) {
  try {
    const update = req.body;
    if (!update || !update.message) {
      return res.status(200).send("OK");
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    if (!text) {
      return res.status(200).send("OK");
    }

    // Helper to fetch all aggregated projects from Firestore
    const getProjects = async () => {
      const snapshot = await db.collection(collectionName).get();
      const phases = snapshot.docs.map((d) => d.data());
      return groupPhasesIntoProjects(phases);
    };

    // ─── COMMAND: /start or /ayuda ──────────────────────────────────────────
    if (text.startsWith("/start") || text.toLowerCase().includes("ayuda") || text === "/help") {
      const reply = 
`🤖 <b>Nexus Tracker Bot</b>

¡Hola! Soy tu asistente de seguimiento de proyectos.

📌 <b>Comandos disponibles:</b>

📊 <b>/resumen</b> - Ver KPIs del tablero ejecutivo
📋 <b>/proyectos</b> - Listar proyectos activos <i>(filtros: todo, completados, riesgo, retrasados)</i>
🔍 <b>/buscar &lt;nombre&gt;</b> - Consultar estado de un proyecto
✏️ <b>/actualizar Proyecto | Fase | Porcentaje | Comentario</b>

<b>Ejemplo de actualización:</b>
<code>/actualizar Algoritmo EECC | Desarrollo | 80 | Avanzando bien</code>`;

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

    // ─── COMMAND: /actualizar ───────────────────────────────────────────────
    if (text.startsWith("/actualizar")) {
      const raw = text.replace("/actualizar", "").trim();
      const parts = raw.split("|").map(p => p.trim());

      if (parts.length < 3) {
        await sendTelegramMessage(botToken, chatId, 
`⚠️ <b>Formato incorrecto.</b>
Usa el separador <code>|</code> entre cada campo:

<code>/actualizar Proyecto | Fase | Porcentaje | Comentario</code>

<b>Ejemplo:</b>
<code>/actualizar Algoritmo EECC | Desarrollo | 85 | Casi listo</code>`);
        return res.status(200).send("OK");
      }

      const [projectNameSearch, phaseSearch, progressStr, commentStr] = parts;
      const newProgress = parseInt(progressStr, 10);

      if (isNaN(newProgress) || newProgress < 0 || newProgress > 100) {
        await sendTelegramMessage(botToken, chatId, "❌ El porcentaje debe ser un número entre 0 y 100.");
        return res.status(200).send("OK");
      }

      const projects = await getProjects();
      const project = findProjectByName(projects, projectNameSearch);

      if (!project) {
        await sendTelegramMessage(botToken, chatId, `❌ No se encontró el proyecto "${escapeHtml(projectNameSearch)}".`);
        return res.status(200).send("OK");
      }

      const matchingPhase = project.phases.find(p => p.phase.toLowerCase().includes(phaseSearch.toLowerCase()));
      if (!matchingPhase) {
        await sendTelegramMessage(botToken, chatId, `❌ No se encontró la fase "${escapeHtml(phaseSearch)}" en "${escapeHtml(project.name)}". Fases: ${project.phases.map(p => p.phase).join(", ")}`);
        return res.status(200).send("OK");
      }

      // Perform update in Firestore
      const updates = {
        progress: newProgress,
        lastModified: Date.now()
      };
      if (newProgress === 100) updates.state = "Completado";
      else if (newProgress === 0) updates.state = "No iniciado";
      else updates.state = "En curso";

      if (commentStr) updates.comment = commentStr;

      await db.collection(collectionName).doc(matchingPhase.id).update(updates);

      const reply = `✅ <b>¡Actualización exitosa!</b>\n\n📌 <b>Proyecto:</b> ${escapeHtml(project.name)}\n🔹 <b>Fase:</b> ${escapeHtml(matchingPhase.phase)}\n📊 <b>Nuevo Progreso:</b> ${newProgress}%\n📝 <b>Comentario:</b> ${escapeHtml(commentStr || "Sin comentarios")}`;
      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // Default response for unhandled text
    await sendTelegramMessage(botToken, chatId, "🤔 No entendí ese comando. Escribe <b>/ayuda</b> para ver las opciones disponibles.");
    return res.status(200).send("OK");

  } catch (err) {
    console.error("[handleTelegramWebhook]", err);
    return res.status(200).send("OK");
  }
}

module.exports = { handleTelegramWebhook };
