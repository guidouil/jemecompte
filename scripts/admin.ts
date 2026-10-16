import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { closeDatabase } from '../src/lib/server/db/index';
import { changeEventStatus, importEventConfiguration, validateEventConfiguration, type AdminActor } from '../src/lib/server/db/admin';

const args = process.argv.slice(2);
const command = args[0];
const reasonIndex = args.indexOf('--reason');
const actor: AdminActor = {
  operator: process.env.ADMIN_OPERATOR ?? userInfo().username,
  reason: reasonIndex >= 0 ? (args[reasonIndex + 1] ?? '') : 'Opération CLI autorisée'
};

try {
  if (command === 'import') {
    const filename = args[1];
    if (!filename || filename.startsWith('--')) throw new Error('Usage: admin import FILE.json [--dry-run] [--reason TEXT]');
    const config = validateEventConfiguration(JSON.parse(await readFile(filename, 'utf8')));
    if (args.includes('--dry-run')) {
      console.log(JSON.stringify({ validation: 'ok', writes: false, status: 'draft', configuration: config }, null, 2));
    } else {
      const id = await importEventConfiguration(config, actor);
      console.log(`Brouillon importé : ${id}. Publication séparée requise.`);
    }
  } else if (command === 'publish' || command === 'pause' || command === 'close') {
    await changeEventStatus(args[1] ?? '', command, actor);
    console.log(`Opération ${command} terminée pour ${args[1]}.`);
  } else if (command === 'seed-demo') {
    const instant = Date.now();
    const day = new Date(instant).toISOString().slice(0, 10);
    const config = {
      slug: `demonstration-republique-${day}-${instant.toString(36)}`,
      name: 'Place de la République',
      cityCode: '75056', cityName: 'Paris',
      description: 'Zone de comptage située place de la République à Paris.',
      geofence: { type: 'Polygon', coordinates: [[[2.3614,48.8663],[2.3651,48.8663],[2.3651,48.8684],[2.3614,48.8684],[2.3614,48.8663]]] },
      startsAt: new Date(instant - 60_000).toISOString(), endsAt: new Date(instant + 24 * 60 * 60 * 1000).toISOString(),
      isTest: true
    };
    const id = await importEventConfiguration(config, { ...actor, reason: 'Création explicite d’une démonstration fictive, sans présence initiale' });
    await changeEventStatus(id, 'publish', actor);
    console.log(`DÉMONSTRATION FICTIVE publiée, zéro présence créée : /evenements/${config.slug} (${id})`);
  } else {
    throw new Error('Usage: admin import FILE.json [--dry-run] | publish|pause|close UUID [--reason TEXT] | seed-demo');
  }
} catch (error) {
  // Validation/operational errors are safe; never dump pg's parameters, detail or stack.
  if (error instanceof Error && !('severity' in error)) console.error(error.message);
  else console.error('Échec de l’opération administrative. Vérifier la connexion et la configuration.');
  process.exitCode = 1;
} finally { await closeDatabase(); }
