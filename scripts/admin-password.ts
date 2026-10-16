import { randomBytes } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { hashAdminPassword } from '../src/lib/server/admin-auth';

async function hidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('keypress', keypress); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); };
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === 'c') { cleanup(); reject(new Error('Opération annulée.')); }
      else if (key.name === 'return') { cleanup(); resolve(value); }
      else if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text) && value.length < 256) value += text;
    };
    process.stdin.on('keypress', keypress);
  });
}

try {
  let password: string;
  if (process.stdin.isTTY) {
    password = await hidden('Mot de passe privé (16 caractères minimum, saisie masquée) : ');
    if (password !== await hidden('Confirmez le mot de passe : ')) throw new Error('Les deux saisies sont différentes.');
  } else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1_024) throw new Error('Entrée trop longue.');
      chunks.push(bytes);
    }
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const hash = await hashAdminPassword(password);
  process.stdout.write(`ADMIN_PASSWORD_HASH='${hash}'\nADMIN_SESSION_SECRET=${randomBytes(32).toString('base64url')}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Impossible de préparer le mot de passe.'}\n`);
  process.exitCode = 1;
}
