import { useAuth } from "../auth/authStore";
import { mockApi, resetStores, signIn } from "../test/utils";
import { ApiError, api } from "./api";

beforeEach(resetStores);

describe("cliente api", () => {
  it("envía el token como Bearer", async () => {
    signIn();
    const { calls } = mockApi({ "GET /boards": () => ({ body: [] }) });
    await api.get("/boards");
    expect(calls[0].headers.Authorization).toMatch(/^Bearer /);
  });

  it("convierte el detail de FastAPI en el mensaje del error", async () => {
    signIn();
    mockApi({ "PATCH /boards/b1": () => ({ status: 403, body: { detail: "Necesitas rol owner" } }) });
    await expect(api.patch("/boards/b1", { name: "x" })).rejects.toMatchObject({
      status: 403,
      message: "Necesitas rol owner",
    });
  });

  it("muestra el primer error de validación (422)", async () => {
    signIn();
    mockApi({
      "POST /boards": () => ({ status: 422, body: { detail: [{ loc: ["body"], msg: "Campo requerido" }] } }),
    });
    await expect(api.post("/boards", {})).rejects.toThrow("Campo requerido");
  });

  it("cierra la sesión si el backend responde 401", async () => {
    signIn();
    mockApi({ "GET /boards": () => ({ status: 401, body: { detail: "El token expiró" } }) });
    await expect(api.get("/boards")).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().token).toBeNull();
  });

  it("da un mensaje claro si no hay conexión", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.get("/boards")).rejects.toMatchObject({
      status: 0,
      message: "No se pudo conectar con el servidor",
    });
  });

  it("acepta respuestas 204 sin cuerpo", async () => {
    signIn();
    mockApi({ "DELETE /boards/b1": () => ({ status: 204 }) });
    await expect(api.delete("/boards/b1")).resolves.toBeUndefined();
  });
});
