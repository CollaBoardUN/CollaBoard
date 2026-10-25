import { fakeJwt } from "@/test/fakes";
import { describeNotification, type AppNotification } from "../domain/notifications";
import { compareMessages, validateChatText, type ChatMessage } from "../domain/chat";
import { initials, relativeTime } from "./format";
import { newId } from "./id";
import { doodleFor, inkFor } from "./ink";
import { readClaims, secondsUntilExpiry } from "./jwt";
import { safeNext } from "./safeNext";

describe("format", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");

  it("muestra tiempos relativos en español", () => {
    expect(relativeTime("2026-10-11T09:00:00Z", now)).toBe("hace 3 horas");
    expect(relativeTime("2026-10-18T12:00:00Z", now)).toBe("la próxima semana");
    expect(relativeTime("2026-10-11T11:59:50Z", now)).toBe("ahora");
  });

  it("trata las fechas sin zona horaria como UTC", () => {
    expect(relativeTime("2026-10-11T10:00:00", now)).toBe("hace 2 horas");
  });

  it("saca iniciales", () => {
    expect(initials("Ana Gómez")).toBe("AG");
    expect(initials("beto")).toBe("B");
    expect(initials("  ")).toBe("?");
  });
});

describe("tinta y garabatos", () => {
  it("son deterministas por id", () => {
    expect(inkFor("ana")).toBe(inkFor("ana"));
    expect(doodleFor("b1")).toEqual(doodleFor("b1"));
  });
});

describe("jwt (solo lectura)", () => {
  it("lee sub, nombre y vencimiento, con tildes", () => {
    const token = fakeJwt({ sub: "u1", name: "José Núñez", exp: 2_000_000_000 });
    expect(readClaims(token)).toEqual({ sub: "u1", name: "José Núñez", email: undefined, exp: 2_000_000_000 });
  });

  it("descarta tokens mal formados o sin sub", () => {
    expect(readClaims("basura")).toBeNull();
    expect(readClaims(fakeJwt({ name: "x" }))).toBeNull();
  });

  it("calcula los segundos restantes (0 si venció)", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const exp = now / 1000 + 90;
    expect(secondsUntilExpiry(fakeJwt({ sub: "u", exp }), now)).toBe(90);
    expect(secondsUntilExpiry(fakeJwt({ sub: "u", exp: now / 1000 - 1 }), now)).toBe(0);
    expect(secondsUntilExpiry(fakeJwt({ sub: "u" }), now)).toBe(0);
  });
});

describe("safeNext (sin redirecciones abiertas)", () => {
  it.each([
    [null, "/"],
    ["/boards/b1", "/boards/b1"],
    ["https://malo.com", "/"],
    ["//malo.com", "/"],
    ["/\\malo.com", "/"],
    ["/bff/api/boards", "/"],
    ["/session/expired", "/"],
    ["/join/abc?x=1", "/join/abc?x=1"],
  ])("%s -> %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });
});

describe("newId", () => {
  it("genera UUID v4 aun sin crypto.randomUUID (contexto inseguro)", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const id = newId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(newId()).not.toBe(id);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});

describe("chat (dominio)", () => {
  it("valida el texto", () => {
    expect(validateChatText("   ")).toBe("Escribe un mensaje");
    expect(validateChatText("x".repeat(2001))).toMatch(/Máximo/);
    expect(validateChatText(" hola ")).toBeNull();
  });

  it("ordena por fecha y desempata por id", () => {
    const m = (id: string, at: string) => ({ id, created_at: at }) as ChatMessage;
    const list = [m("b", "2026-10-25T10:00:00Z"), m("a", "2026-10-25T10:00:00Z"), m("c", "2026-10-25T09:00:00Z")];
    expect(list.sort(compareMessages).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
});

describe("notificaciones (texto)", () => {
  const base: AppNotification = {
    id: "n1",
    type: "invite.accepted",
    board_id: "b1",
    actor_id: "beto",
    payload: { actor_name: "Beto", board_name: "Ideas" },
    created_at: "2026-10-25T10:00:00Z",
    read_at: null,
  };

  it("describe invitación aceptada y mensaje de chat", () => {
    expect(describeNotification(base).title).toBe("Beto se unió a Ideas");
    const chat = { ...base, type: "chat.message.created", payload: { ...base.payload, preview: "Hola\n\nequipo" } };
    expect(describeNotification(chat)).toEqual({ title: "Beto escribió en Ideas", body: "Hola equipo" });
  });

  it("tolera payloads incompletos y tipos desconocidos", () => {
    expect(describeNotification({ ...base, payload: {} }).title).toBe("Alguien se unió a un tablero");
    expect(describeNotification({ ...base, type: "otro.evento" }).title).toBe("Nueva notificación");
  });
});
