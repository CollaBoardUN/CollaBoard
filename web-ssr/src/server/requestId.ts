import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { pickRequestId } from "./requestIdPolicy";

export { pickRequestId };

/** Identificador de la petición actual (el mismo para todo el render). */
export const currentRequestId = cache(async (): Promise<string> => {
  return pickRequestId((await headers()).get("x-request-id"));
});
