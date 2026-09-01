const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Try default initialization (ADC or gcloud credentials)
try {
  admin.initializeApp({
    projectId: "nexus-tracker-b7a75"
  });
} catch (e) {
  // Already initialized or fallback
}

const db = admin.firestore();

const COLLECTIONS_TO_BACKUP = [
  "phases",
  "clients",
  "userRoles",
  "audit_logs",
  "telegram_sessions"
];

async function runBackup() {
  console.log("🚀 Iniciando Backup con Firebase Admin SDK...");
  const backupData = {
    metadata: {
      projectId: "nexus-tracker-b7a75",
      timestamp: new Date().toISOString(),
      version: "1.0"
    },
    collections: {}
  };

  for (const colName of COLLECTIONS_TO_BACKUP) {
    try {
      console.log(`📥 Respaldando colección: ${colName}...`);
      const snapshot = await db.collection(colName).get();
      backupData.collections[colName] = [];

      snapshot.forEach(doc => {
        backupData.collections[colName].push({
          id: doc.id,
          data: doc.data()
        });
      });

      console.log(`   ✅ ${backupData.collections[colName].length} documentos encontrados en ${colName}.`);
    } catch (err) {
      console.error(`   ❌ Error al respaldar colección ${colName}:`, err.message);
      backupData.collections[colName] = [];
    }
  }

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

  console.log("\n🎉 Backup completado con éxito!");
  console.log(`📁 Archivo con timestamp: ${timestampedPath}`);
  console.log(`📁 Archivo latest: ${latestPath}`);
  process.exit(0);
}

runBackup().catch(err => {
  console.error("❌ Error fatal durante el backup:", err);
  process.exit(1);
});
