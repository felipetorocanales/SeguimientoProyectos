import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESTORE_URL = "https://api-4lvkcxghba-uc.a.run.app/backup-restore";

function postRestore(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => (responseData += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(responseData));
          } catch (e) {
            resolve({ raw: responseData });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function runRestore() {
  const targetFile = process.argv[2] || path.join(__dirname, "..", "backups", "backup_latest.json");

  if (!fs.existsSync(targetFile)) {
    console.error(`❌ No se encontró el archivo de backup en: ${targetFile}`);
    process.exit(1);
  }

  console.log(`🚀 Restaurando base de datos Firestore desde: ${targetFile}`);
  const rawData = fs.readFileSync(targetFile, "utf8");
  const backup = JSON.parse(rawData);

  const result = await postRestore(RESTORE_URL, backup);
  console.log("\n🎉 ¡Restauración completada con éxito!");
  console.log("📊 Reporte de documentos restaurados:", result.report || result);
}

runRestore().catch(err => {
  console.error("❌ Error al restaurar:", err.message);
  process.exit(1);
});
