import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RequireAuth } from "../auth/RequireAuth";
import { ShareDialog } from "../components/ShareDialog";
import { Toaster } from "../components/Toaster";
import { makeBoard, mockApi, renderAt, resetStores, signIn } from "../test/utils";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "./DashboardPage";
import { JoinPage } from "./JoinPage";

beforeEach(() => {
  resetStores();
  signIn();
});

describe("RequireAuth", () => {
  it("manda al login si no hay sesión", () => {
    resetStores();
    renderAt("/join/abc", "/join/:token", <RequireAuth><p>privado</p></RequireAuth>);
    expect(screen.getByText("Pantalla de login")).toBeInTheDocument();
  });
});

describe("Dashboard", () => {
  it("muestra el estado vacío con un botón para crear", async () => {
    mockApi({ "GET /boards": () => ({ body: [] }) });
    renderAt("/", "/", <DashboardPage />);
    expect(await screen.findByText("Aquí aparecerán tus tableros")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear mi primer tablero" })).toBeInTheDocument();
  });

  it("lista los tableros y filtra los compartidos", async () => {
    mockApi({
      "GET /boards": () => ({
        body: [
          makeBoard({ id: "b1", name: "Mío" }),
          makeBoard({ id: "b2", name: "De Beto", my_role: "editor", owner_id: "beto", member_count: 3 }),
        ],
      }),
    });
    const user = userEvent.setup();
    renderAt("/", "/", <DashboardPage />);
    expect(await screen.findByText("Mío")).toBeInTheDocument();
    expect(screen.getByText("De Beto")).toBeInTheDocument();
    expect(screen.getByText(/3 personas/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Compartidos conmigo" }));
    expect(screen.queryByText("Mío")).not.toBeInTheDocument();
    expect(screen.getByText("De Beto")).toBeInTheDocument();
  });

  it("crea un tablero y abre su vista", async () => {
    const { calls } = mockApi({
      "GET /boards": () => ({ body: [] }),
      "POST /boards": (body) => ({
        status: 201,
        body: makeBoard({ id: "nuevo", name: (body as { name: string }).name }),
      }),
    });
    const user = userEvent.setup();
    renderAt("/", "/", <DashboardPage />);
    await user.click(await screen.findByRole("button", { name: "Nuevo tablero" }));
    const dialog = screen.getByRole("dialog", { name: "Nuevo tablero" });
    await user.type(within(dialog).getByLabelText("Nombre"), "  Retro  ");
    await user.click(within(dialog).getByRole("button", { name: "Crear tablero" }));
    expect(await screen.findByText("Vista del tablero")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Retro" });
  });

  it("el editor no ve Renombrar ni Borrar, sino Salir", async () => {
    mockApi({ "GET /boards": () => ({ body: [makeBoard({ my_role: "editor", owner_id: "beto" })] }) });
    const user = userEvent.setup();
    renderAt("/", "/", <DashboardPage />);
    await user.click(await screen.findByRole("button", { name: /Opciones de/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("Renombrar")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Borrar tablero")).not.toBeInTheDocument();
    expect(within(menu).getByText("Salir del tablero")).toBeInTheDocument();
  });

  it("borra un tablero tras confirmar", async () => {
    mockApi({
      "GET /boards": () => ({ body: [makeBoard()] }),
      "DELETE /boards/b1": () => ({ status: 204 }),
    });
    const user = userEvent.setup();
    renderAt("/", "/", <DashboardPage />);
    await user.click(await screen.findByRole("button", { name: /Opciones de/ }));
    await user.click(screen.getByRole("menuitem", { name: "Borrar tablero" }));
    await user.click(screen.getByRole("button", { name: "Borrar tablero" }));
    await waitFor(() => expect(screen.queryByText("Ideas del sprint")).not.toBeInTheDocument());
  });
});

describe("Compartir", () => {
  it("el owner crea un link de solo lectura", async () => {
    const { calls } = mockApi({
      "GET /boards/b1/members": () => ({
        body: [{ user_id: "ana", display_name: "Ana", role: "owner", joined_at: "2026-10-10T12:00:00Z" }],
      }),
      "GET /boards/b1/invites": () => ({ body: [] }),
      "POST /boards/b1/invite": () => ({
        status: 201,
        body: {
          id: "i1",
          token: "tok",
          url: "http://localhost:5173/join/tok",
          role: "viewer",
          created_at: "2026-10-11T12:00:00Z",
          expires_at: null,
          uses: 0,
        },
      }),
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ShareDialog board={makeBoard()} onClose={() => {}} />
        <Toaster />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Personas con acceso (1)")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Solo ver/));
    await user.selectOptions(screen.getByLabelText("El link vence en"), "Sin vencimiento");
    await user.click(screen.getByRole("button", { name: "Crear y copiar link" }));

    expect(await screen.findByDisplayValue("http://localhost:5173/join/tok")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      role: "viewer",
      expires_in_hours: null,
    });
  });

  it("un editor solo ve la lista de miembros", async () => {
    mockApi({
      "GET /boards/b1/members": () => ({
        body: [
          { user_id: "beto", display_name: "Beto", role: "owner", joined_at: "2026-10-10T12:00:00Z" },
          { user_id: "ana", display_name: "Ana", role: "editor", joined_at: "2026-10-10T12:00:00Z" },
        ],
      }),
    });
    render(
      <MemoryRouter>
        <ShareDialog board={makeBoard({ my_role: "editor", owner_id: "beto" })} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Personas con acceso (2)")).toBeInTheDocument();
    expect(screen.getByText(/Solo el dueño del tablero puede invitar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crear y copiar link" })).not.toBeInTheDocument();
    expect(screen.getByText("(tú)")).toBeInTheDocument();
  });
});

describe("Unirse por link", () => {
  it("muestra el tablero y el rol, y al aceptar abre el tablero", async () => {
    mockApi({
      "GET /invites/tok": () => ({
        body: {
          board_id: "b1",
          board_name: "Retro de octubre",
          role: "editor",
          already_member: false,
          current_role: null,
        },
      }),
      "POST /invites/tok/accept": () => ({ body: { board_id: "b1", role: "editor" } }),
      "GET /boards": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderAt("/join/tok", "/join/:token", <JoinPage />);
    expect(await screen.findByText("Retro de octubre")).toBeInTheDocument();
    expect(screen.getByText("Puede editar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unirme al tablero" }));
    expect(await screen.findByText("Vista del tablero")).toBeInTheDocument();
  });

  it("explica qué hacer si el link expiró", async () => {
    mockApi({
      "GET /invites/viejo": () => ({
        status: 404,
        body: { detail: "El link de invitación no existe o ya expiró" },
      }),
    });
    renderAt("/join/viejo", "/join/:token", <JoinPage />);
    expect(await screen.findByText("Este link no funciona")).toBeInTheDocument();
    expect(screen.getByText(/Pide al dueño del tablero un link nuevo/)).toBeInTheDocument();
  });

  it("si ya es miembro, ofrece abrir el tablero", async () => {
    mockApi({
      "GET /invites/tok": () => ({
        body: { board_id: "b1", board_name: "X", role: "viewer", already_member: true, current_role: "editor" },
      }),
    });
    renderAt("/join/tok", "/join/:token", <JoinPage />);
    expect(await screen.findByText("Ya eres miembro de este tablero.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir tablero" })).toHaveAttribute("href", "/boards/b1");
  });
});
