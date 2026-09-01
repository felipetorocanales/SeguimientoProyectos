const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

try {
  admin.initializeApp({
    projectId: "nexus-tracker-b7a75"
  });
} catch (e) {}

const db = admin.firestore();

async function runRestore() {
  const targetFile = process.argv[2] || path.join(__dirname, "..", "backups", "backup_latest.json");

  if (!fs.existsSync(targetFile)) {
    console.error(`❌ No se encontró el archivo de backup en: ${targetFile}`);
    process.exit(1);
  }

  console.log(`🚀 Iniciando Restauración de Firestore con Admin SDK desde: ${targetFile}`);
  const rawData = fs.readFileSync(targetFile, "utf8");
  const backup = JSON.parse(rawData);

  for (const [colName, docs] of Object.entries(backup.collections || {})) {
    console.log(`📤 Restaurando colección: ${colName} (${docs.length} documentos)...`);
    for (const docItem of docs) {
      try {
        await db.collection(colName).doc(docItem.id).set(docItem.data);
      } catch (err) {
        console.error(`   ⚠️ Error al restaurar doc ${docItem.id} en ${colName}:`, err.message);
      }
    }
    console.log(`   ✅ Colección ${colName} restaurada.`);
  }

  console.log("\n🎉 Restauración completada con éxito!");
  process.exit(0);
}

runRestore().catch(err => {
  console.error("❌ Error fatal durante la restauración:", err);
  process.exit(1);
});
