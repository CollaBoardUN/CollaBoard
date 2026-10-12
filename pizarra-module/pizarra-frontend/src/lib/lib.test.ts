import { safeNext } from "../auth/safeNext";
import { decodeJwt, userFromToken } from "../auth/authStore";
import { fakeToken } from "../test/utils";
import { initials, relativeTime } from "./format";
import { doodleFor, inkFor } from "./ink";

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

describe("tokens", () => {
  it("lee el usuario del JWT", () => {
    expect(userFromToken(fakeToken({ sub: "ana", name: "Ana" }))).toEqual({ id: "ana", name: "Ana" });
    expect(userFromToken(fakeToken({ sub: "beto", email: "b@x.co" }))?.name).toBe("b@x.co");
  });

  it("descarta tokens vencidos, sin sub o mal formados", () => {
    expect(userFromToken(fakeToken({ sub: "ana", exp: 1 }))).toBeNull();
    expect(userFromToken(fakeToken({ name: "x" }))).toBeNull();
    expect(decodeJwt("basura")).toBeNull();
  });

  it("soporta tildes en el nombre", () => {
    expect(userFromToken(fakeToken({ sub: "j", name: "José Núñez" }))?.name).toBe("José Núñez");
  });
});

describe("safeNext", () => {
  it("solo permite rutas internas", () => {
    expect(safeNext("/join/abc")).toBe("/join/abc");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});

describe("ink", () => {
  it("es determinista", () => {
    expect(inkFor("ana")).toBe(inkFor("ana"));
    expect(doodleFor("b1")).toEqual(doodleFor("b1"));
  });
});
