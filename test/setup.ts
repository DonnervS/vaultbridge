import { webcrypto } from "node:crypto";

// Node < 20 hat crypto nicht global; für WebCrypto-Tests sicherstellen.
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}
