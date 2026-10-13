/** Cliente HTTP del microservicio de autenticación Go (independiente de FastAPI). */
export const AUTH_URL = (import.meta.env.VITE_AUTH_URL ?? "http://localhost:8001").replace(/\/$/, "");

interface SessionUser {
  id: string;
  name: string;
  email: string;
}
export interface AuthSession {
  access_token: string;
  token_type: "bearer";
  user: SessionUser;
}
export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  confirm_password: string;
}

async function postAuth<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${AUTH_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("No se pudo conectar con el servicio de autenticación.");
  }

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data && typeof data.detail === "string"
        ? data.detail
        : `No fue posible completar la solicitud (HTTP ${response.status}).`;
    throw new Error(detail);
  }
  return data as T;
}

export const authApi = {
  register: (body: RegisterInput) => postAuth<AuthSession>("/auth/register", body),
  login: (body: { email: string; password: string }) =>
    postAuth<AuthSession>("/auth/login", body),
};
