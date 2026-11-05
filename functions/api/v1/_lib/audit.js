export async function createAuditEventId(db) {
  const { results } = await db.prepare("PRAGMA table_info(audit_events)").all();
  const idColumn = (results || []).find((column) => column.name === "id");
  if (!idColumn) throw new Error("audit_events.id column is missing");
  return /INT/i.test(String(idColumn.type || "")) ? null : crypto.randomUUID();
}
