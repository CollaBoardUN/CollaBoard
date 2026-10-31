/** Reglas del identificador de petición (sin dependencias: lo usa también el proxy). */
const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Acepta el id que llega del gateway si es razonable; si no, genera uno. */
export function pickRequestId(incoming: string | null | undefined): string {
  return incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
}
