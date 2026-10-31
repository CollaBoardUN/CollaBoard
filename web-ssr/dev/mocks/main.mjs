// Punto de entrada de los mocks de desarrollo (ver server.mjs).
import { start } from "./server.mjs";

const server = start();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
