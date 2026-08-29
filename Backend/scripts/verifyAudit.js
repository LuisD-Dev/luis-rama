import { verifyAuditChain } from '../services/adminAuditService.js';

try {
  const result = await verifyAuditChain();
  if (!result.valid) {
    console.error(`Audit chain broken at ${result.eventId}: expected ${result.expected}, found ${result.actual}`);
    process.exitCode = 1;
  } else {
    console.log(`Audit chain valid (${result.count} events).`);
  }
} catch (error) {
  console.error(`Audit verification failed: ${error.message}`);
  process.exitCode = 1;
}