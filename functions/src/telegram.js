/**
 * telegram.js - Telegram Bot Webhook Handler for Nexus Tracker
 *
 * Receives updates from Telegram and replies using standard Telegram Bot API.
 */

const https = require("https");
const {
  groupPhasesIntoProjects,
  findProjectByName,
  computeSummary,
} = require("./projectHelpers");

/**
 * Send a message back to Telegram
 */
function sendTelegramMessage(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
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
      res.on("end", () => resolve(data));
    });

    req.on("error", (err) => reject(err));
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
`🤖 *Nexus Tracker Bot*

¡Hola! Soy tu asistente de seguimiento de proyectos.

📌 *Comandos disponibles:*

📊 */resumen* - Ver KPIs del tablero ejecutivo
📋 */proyectos* - Listar proyectos en cartera
🔍 */buscar <nombre>* - Consultar estado de un proyecto
✏️ */actualizar Proyecto | Fase | Porcentaje | Comentario*

*Ejemplo de actualización:*
\`/actualizar Algoritmo EECC | Desarrollo | 80 | Avanzando bien\``;

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /resumen ──────────────────────────────────────────────────
    if (text.startsWith("/resumen") || text.toLowerCase() === "resumen") {
      const projects = await getProjects();
      const summary = computeSummary(projects);

      const reply = 
`📊 *Resumen Ejecutivo - Nexus Tracker*

🔹 *Total Proyectos:* ${summary.total}
✅ *Completados:* ${summary.completed}
🟢 *A tiempo:* ${summary.onTrack}
⚠️ *En riesgo:* ${summary.atRisk}
🚨 *Retrasados:* ${summary.delayed}
📈 *Cumplimiento SLA:* *${summary.sla}%*

${summary.criticalProjects.length > 0 ? `🔥 *Proyectos críticos (${summary.criticalProjects.length}):*\n` + summary.criticalProjects.map(p => `• ${p}`).join("\n") : "✨ ¡No hay proyectos críticos en riesgo!"}`;

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /proyectos ────────────────────────────────────────────────
    if (text.startsWith("/proyectos") || text.toLowerCase() === "proyectos") {
      const projects = await getProjects();
      if (projects.length === 0) {
        await sendTelegramMessage(botToken, chatId, "📭 No hay proyectos en la cartera.");
        return res.status(200).send("OK");
      }

      let reply = `📋 *Cartera de Proyectos (${projects.length}):*\n\n`;
      projects.slice(0, 15).forEach((p) => {
        let badge = "🟢";
        if (p.health === "completed") badge = "✅";
        else if (p.health === "at_risk") badge = "⚠️";
        else if (p.health === "delayed") badge = "🚨";

        reply += `${badge} *${p.name}*\n   ├ Progreso: *${p.overallProgress}%* (${p.healthLabel})\n   └ Cliente: ${p.client}\n\n`;
      });

      if (projects.length > 15) {
        reply += `_...y ${projects.length - 15} proyectos más._`;
      }

      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // ─── COMMAND: /buscar <nombre> ──────────────────────────────────────────
    if (text.startsWith("/buscar")) {
      const query = text.replace("/buscar", "").trim();
      if (!query) {
        await sendTelegramMessage(botToken, chatId, "❓ Por favor escribe el nombre a buscar. Ej: \`/buscar Algoritmo\``);
        return res.status(200).send("OK");
      }

      const projects = await getProjects();
      const project = findProjectByName(projects, query);

      if (!project) {
        await sendTelegramMessage(botToken, chatId, `❌ No se encontró ningún proyecto que coincida con "${query}".`);
        return res.status(200).send("OK");
      }

      let phasesText = project.phases.map(p => {
        let st = p.state === "Completado" ? "✅" : (p.state === "En curso" ? "🔄" : "⏳");
        return `   • *${p.phase}:* ${p.progress}% ${st} ${p.comment ? `_("${p.comment}")_` : ""}`;
      }).join("\n");

      const reply = 
`📌 *Detalle de Proyecto:*

*Nombre:* ${project.name}
*Cliente:* ${project.client}
*Responsable:* ${project.responsible || "No asignado"}
*Estado Global:* ${project.healthLabel} (${project.overallProgress}%)
📅 *Fecha Entrega:* ${project.deliveryDate || "No definida"}

*Fases:*
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
`⚠️ *Formato incorrecto.*
Usa el separador \`|\` entre cada campo:

\`/actualizar Proyecto | Fase | Porcentaje | Comentario\`

*Ejemplo:*
\`/actualizar Algoritmo EECC | Desarrollo | 85 | Casi listo\``);
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
        await sendTelegramMessage(botToken, chatId, `❌ No se encontró el proyecto "${projectNameSearch}".`);
        return res.status(200).send("OK");
      }

      const matchingPhase = project.phases.find(p => p.phase.toLowerCase().includes(phaseSearch.toLowerCase()));
      if (!matchingPhase) {
        await sendTelegramMessage(botToken, chatId, `❌ No se encontró la fase "${phaseSearch}" en "${project.name}". Fases: ${project.phases.map(p => p.phase).join(", ")}`);
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

      const reply = `✅ *¡Actualización exitosa!*\n\n📌 *Proyecto:* ${project.name}\n🔹 *Fase:* ${matchingPhase.phase}\n📊 *Nuevo Progreso:* ${newProgress}%\n📝 *Comentario:* ${commentStr || "Sin comentarios"}`;
      await sendTelegramMessage(botToken, chatId, reply);
      return res.status(200).send("OK");
    }

    // Default response for unhandled text
    await sendTelegramMessage(botToken, chatId, "🤔 No entendí ese comando. Escribe */ayuda* para ver las opciones disponibles.");
    return res.status(200).send("OK");

  } catch (err) {
    console.error("[handleTelegramWebhook]", err);
    return res.status(200).send("OK");
  }
}

module.exports = { handleTelegramWebhook };
