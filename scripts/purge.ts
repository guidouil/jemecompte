import { userInfo } from 'node:os';
import { closeDatabase } from '../src/lib/server/db/index';
import { purgeEvent, purgeExpiredEvents } from '../src/lib/server/privacy';

const actor = { operator: process.env.ADMIN_OPERATOR ?? userInfo().username, reason: 'Purge à échéance endsAt + 48 heures et conservation des agrégats' };
try {
  const argument = process.argv[2];
  if (!argument) throw new Error('Usage: db:purge UUID | --expired');
  if (argument === '--expired') {
    const result = await purgeExpiredEvents(actor);
    console.log(JSON.stringify(result, null, 2));
    if (result.failed.length) process.exitCode = 1;
  } else { console.log(await purgeEvent(argument, actor)); }
} catch { console.error('Purge impossible : vérifier échéance, UUID, connexion et réconciliation. Aucune purge forcée.'); process.exitCode = 1; }
finally { await closeDatabase(); }
