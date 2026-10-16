import { userInfo } from 'node:os';
import { closeDatabase } from '../src/lib/server/db/index';
import { reconcileEvent } from '../src/lib/server/privacy';

try {
  const eventId = process.argv[2];
  if (!eventId) throw new Error('Usage: db:reconcile UUID [--finalize]');
  const report = await reconcileEvent(eventId, {
    finalize: process.argv.includes('--finalize'),
    actor: { operator: process.env.ADMIN_OPERATOR ?? userInfo().username, reason: 'Réconciliation opérateur et finalisation si demandée' }
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'mismatch') process.exitCode = 1;
} catch { console.error('Réconciliation impossible. Vérifier UUID, état, connexion et cohérence sans exposer de données individuelles.'); process.exitCode = 1; }
finally { await closeDatabase(); }
