import PouchDB from "pouchdb-core";
import memory from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";

PouchDB.plugin(memory).plugin(replication);

let counter = 0;

export function createTestPouch(name?: string): PouchDB.Database {
  return new PouchDB(name ?? `vb-test-${counter++}`, { adapter: "memory" });
}

export { PouchDB };
