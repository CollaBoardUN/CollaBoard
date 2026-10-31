import { decideBff, publicOrigin, type BffInput } from "./bffPolicy";

const base: BffInput = {
  method: "GET",
  url: "/bff/api/boards",
  origin: null,
  selfOrigin: "http://localhost:8088",
  allowedOrigins: [],
  clientHeader: null,
};

describe("BFF: lista blanca de rutas", () => {
  it("reenvía rutas del contrato conservando la query", () => {
    expect(decideBff({ ...base, url: "/bff/api/chat/boards/b1/messages?before=m3&limit=30" })).toEqual({
      ok: true,
      path: "/api/chat/boards/b1/messages?before=m3&limit=30",
    });
  });

  it.each(["/bff/api/internal/boards/b1/access", "/bff/internal/x", "/bff/api/auth/login", "/bff/api/boards/../x", "/bffx/api/boards", "/bff/"])(
    "bloquea %s",
    (url) => {
      expect(decideBff({ ...base, url })).toMatchObject({ ok: false, status: 404 });
    },
  );

  it("rechaza métodos no soportados", () => {
    expect(decideBff({ ...base, method: "TRACE" })).toMatchObject({ ok: false, status: 405 });
  });
});

describe("BFF: protección CSRF en métodos que modifican", () => {
  const write = { ...base, method: "POST", clientHeader: "web" };

  it("acepta el mismo origen con la cabecera del cliente web", () => {
    expect(decideBff({ ...write, origin: "http://localhost:8088" })).toMatchObject({ ok: true });
  });

  it("rechaza otro origen, origen ausente o falta de cabecera", () => {
    expect(decideBff({ ...write, origin: "https://malicioso.example" })).toMatchObject({ ok: false, status: 403 });
    expect(decideBff({ ...write, origin: null })).toMatchObject({ ok: false, status: 403 });
    expect(decideBff({ ...write, origin: "http://localhost:8088", clientHeader: null })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("acepta orígenes adicionales configurados", () => {
    expect(
      decideBff({ ...write, origin: "http://localhost:3100", allowedOrigins: ["http://localhost:3100"] }),
    ).toMatchObject({ ok: true });
  });

  it("las lecturas no exigen Origin", () => {
    expect(decideBff(base)).toMatchObject({ ok: true });
  });
});

describe("origen público detrás del gateway", () => {
  it("usa x-forwarded-host y x-forwarded-proto", () => {
    const headers = new Headers({ host: "web-ssr:3000", "x-forwarded-host": "localhost:8088", "x-forwarded-proto": "http" });
    expect(publicOrigin(headers, "http://web-ssr:3000/bff/api/boards")).toBe("http://localhost:8088");
  });

  it("sin proxy usa el host de la petición", () => {
    expect(publicOrigin(new Headers({ host: "localhost:3100" }), "http://localhost:3100/x")).toBe("http://localhost:3100");
  });
});
