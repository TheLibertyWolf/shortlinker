import { closeConnections, db } from "./db.js";
import { verifyDomain } from "./domains.js";

async function main(): Promise<void> {
  const domains = await db.query<{ id: string; hostname: string }>(
    "SELECT id, hostname::text FROM domains WHERE status = 'pending' ORDER BY hostname"
  );
  if (!domains.rowCount) {
    console.log("No pending domains.");
    return;
  }
  let failures = 0;
  for (const domain of domains.rows) {
    const result = await verifyDomain(domain.id);
    console.log(`${domain.hostname}: ${result.verified ? "verified" : `pending (${result.message})`}`);
    if (!result.verified) failures += 1;
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(closeConnections);
