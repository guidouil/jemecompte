const DATABASE_NAME = 'jemecompte-identity';
const STORE_NAME = 'identity';
const SINGLETON_KEY = 'master-v1';
const EVENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class IdentityError extends Error {
  constructor(
    public readonly code: 'storage_unavailable' | 'crypto_unavailable' | 'invalid_event' | 'invalid_day',
    message: string
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

interface StoredIdentity {
  key: CryptoKey;
  createdAt: number;
}

function storageError(): IdentityError {
  return new IdentityError(
    'storage_unavailable',
    'Le stockage de ce navigateur est indisponible. Autorisez le stockage du site puis réessayez.'
  );
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(storageError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, 1);
    } catch {
      reject(storageError());
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => {
      settled = true;
      reject(storageError());
    };
  });
}

function isStoredIdentity(value: unknown): value is StoredIdentity {
  if (!value || typeof value !== 'object' || !('key' in value) || !('createdAt' in value)) {
    return false;
  }
  const { key, createdAt } = value as StoredIdentity;
  const algorithm = key?.algorithm as HmacKeyAlgorithm | undefined;
  return Boolean(
    typeof createdAt === 'number' &&
      Number.isFinite(createdAt) &&
      key?.type === 'secret' &&
      !key.extractable &&
      Array.isArray(key.usages) &&
      key.usages.length === 1 &&
      key.usages[0] === 'sign' &&
      algorithm?.name === 'HMAC' &&
      algorithm.length === 256 &&
      algorithm.hash?.name === 'SHA-256'
  );
}

async function getLocalKey(): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new IdentityError('crypto_unavailable', 'Ce navigateur ne permet pas le comptage sécurisé.');
  }
  // Generate before opening the transaction: awaiting Web Crypto inside it can make it inactive.
  const candidate: StoredIdentity = {
    key: await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    ),
    createdAt: Date.now()
  };
  const database = await openDatabase();
  try {
    return await new Promise<CryptoKey>((resolve, reject) => {
      let selected: CryptoKey | undefined;
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(SINGLETON_KEY);
      request.onsuccess = () => {
        if (request.result === undefined) {
          selected = candidate.key;
          store.add(candidate, SINGLETON_KEY);
        } else if (isStoredIdentity(request.result)) {
          selected = request.result.key;
        } else {
          // A damaged record must not silently become a second identity.
          transaction.abort();
        }
      };
      transaction.oncomplete = () => (selected ? resolve(selected) : reject(storageError()));
      transaction.onabort = transaction.onerror = () => reject(storageError());
    });
  } catch {
    throw storageError();
  } finally {
    database.close();
  }
}

/** Re-read the singleton for each action; never retain an old key in a long-lived tab. */
export async function getEventIdentity(eventId: string): Promise<string> {
  if (!EVENT_UUID.test(eventId)) {
    throw new IdentityError('invalid_event', 'Cet événement est invalide. Rechargez la page.');
  }
  return signIdentity(`jemecompte.fr\0presence:v1\0${eventId}`);
}

/** A server-supplied Paris day scopes deduplication without a shared permanent identifier. */
export async function getDailySupportIdentity(day: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new IdentityError('invalid_day', 'Le jour du soutien est invalide. Rechargez la page.');
  }
  return signIdentity(`jemecompte.fr\0support-day:v1\0${day}`);
}

async function signIdentity(context: string): Promise<string> {
  const key = await getLocalKey();
  const message = new TextEncoder().encode(context);
  const result = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  return btoa(String.fromCharCode(...result))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Explicit local erasure only. There is deliberately no automatic rotation during the pilot. */
export async function eraseLocalIdentity(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(storageError());
    });
  } catch {
    throw storageError();
  } finally {
    database.close();
  }
}
