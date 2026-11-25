const KEY_VALUE_PREFIX = '@jeswr/key-value:';

/**
 * Names of every IndexedDB database pod-auth's default browser stores created, whichever client
 * identifier and redirect they were created for (an earlier build, a dev build). pod-auth keys
 * them by `["pod-auth", clientId, redirectUri]` inside key-value-kit's
 * `@jeswr/key-value:<json namespace>:` naming, as of the vendored packages
 * (frontend/vendor/solid). The integration spec fails if a later version renames them.
 */
export function podAuthDatabaseNames(all: readonly string[]): string[] {
  const escaped = JSON.stringify('["pod-auth",').slice(1, -1);
  return all.filter((name) => name.startsWith(KEY_VALUE_PREFIX) && name.includes(escaped));
}

/** `wiped`: every database is gone. `deferred`: a delete is only queued behind an open connection. */
export type WipeOutcome = 'wiped' | 'deferred';

/**
 * Deletes pod-auth's databases for this configuration. A delete that is `blocked` by a
 * connection pod-auth still holds counts as deferred: the request stays queued and completes
 * when the window reloads, and the stored sessions were already purged by pod-auth's logout.
 * A database that cannot be deleted at all rejects.
 */
export async function deletePodAuthDatabases(
  idb: Pick<IDBFactory, 'deleteDatabase'> & { databases?: IDBFactory['databases'] } = globalThis.indexedDB,
): Promise<WipeOutcome> {
  // Without a way to list the databases nothing can be claimed deleted.
  if (!idb || typeof idb.databases !== 'function') throw new Error('cannot list databases');
  const listed = await idb.databases();
  const names = podAuthDatabaseNames(listed.flatMap((d) => (typeof d.name === 'string' ? [d.name] : [])));
  let outcome: WipeOutcome = 'wiped';
  for (const name of names) {
    const result = await new Promise<WipeOutcome>((resolve, reject) => {
      const req = idb.deleteDatabase(name);
      req.onsuccess = () => resolve('wiped');
      req.onerror = () => reject(new Error('delete failed'));
      req.onblocked = () => resolve('deferred');
    });
    if (result === 'deferred') outcome = 'deferred';
  }
  return outcome;
}
