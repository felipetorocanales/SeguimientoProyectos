import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKUP_URL = "https://api-4lvkcxghba-uc.a.run.app/backup-export";

function fetchBackup(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Error al parsear JSON recibido: ${data}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on("error", reject);
  });
}

async function runBackup() {
  console.log("🚀 Descargando respaldo completo de Firestore desde Cloud Functions...");
  const backupData = await fetchBackup(BACKUP_URL);

  const backupDir = path.join(__dirname, "..", "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestampStr = new Date().toISOString().replace(/[:.]/g, "-");
  const timestampedPath = path.join(backupDir, `backup_firestore_${timestampStr}.json`);
  const latestPath = path.join(backupDir, `backup_latest.json`);

  const jsonStr = JSON.stringify(backupData, null, 2);
  fs.writeFileSync(timestampedPath, jsonStr, "utf8");
  fs.writeFileSync(latestPath, jsonStr, "utf8");

  console.log("\n📊 Resumen de colecciones respaldadas:");
  for (const [col, docs] of Object.entries(backupData.collections || {})) {
    console.log(`   📁 ${col}: ${docs.length} documentos`);
  }

  console.log("\n🎉 ¡Backup guardado localmente con éxito!");
  console.log(`💾 Archivo con fecha: ${timestampedPath}`);
  console.log(`💾 Archivo más reciente: ${latestPath}`);
}

runBackup().catch(err => {
  console.error("❌ Error al realizar backup:", err.message);
  process.exit(1);
});
