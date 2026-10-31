"use server";

import { redirect } from "next/navigation";

import type { JoinResult } from "@/core/domain/types";
import { requireSession } from "@/server/dal";
import { GatewayError, gatewayJson } from "@/server/gateway";
import { currentRequestId } from "@/server/requestId";

export interface JoinState {
  error: string | null;
}

/** Acepta una invitación con la sesión del usuario y abre el tablero. */
export async function acceptInviteAction(token: string, _previous: JoinState): Promise<JoinState> {
  const nextPath = `/join/${encodeURIComponent(token)}`;
  const session = await requireSession(nextPath);
  let result: JoinResult;
  try {
    result = await gatewayJson<JoinResult>(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      token: session.token,
      requestId: await currentRequestId(),
    });
  } catch (error) {
    if (error instanceof GatewayError && error.status === 401) redirect(`/session/expired?next=${encodeURIComponent(nextPath)}`);
    return { error: error instanceof GatewayError ? error.message : "No fue posible unirte al tablero." };
  }
  redirect(`/boards/${encodeURIComponent(result.board_id)}?joined=1`);
}
