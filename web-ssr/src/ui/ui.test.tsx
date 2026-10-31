import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { vi } from "vitest";

import type { ChatMessage } from "@/core/domain/chat";
import type { AppNotification } from "@/core/domain/notifications";
import { ANA, fakeNavigation, fakeTransport, makeBoard, Providers, renderWithProviders } from "@/test/fakes";
import { BoardWorkspace } from "./board/BoardWorkspace";
import { ChatPanel } from "./chat/ChatPanel";
import { DashboardView } from "./dashboard/DashboardView";
import { NotificationBell } from "./notifications/NotificationBell";

const message = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  board_id: "b1",
  sender_id: "beto",
  sender_name: "Beto Ruiz",
  text: `Mensaje ${id}`,
  client_message_id: `c-${id}`,
  created_at: "2026-10-25T15:04:00Z",
  ...over,
});

const notification = (id: string, over: Partial<AppNotification> = {}): AppNotification => ({
  id,
  type: "invite.accepted",
  board_id: "b1",
  actor_id: "beto",
  payload: { actor_name: "Beto", board_name: "Ideas del sprint" },
  created_at: "2026-10-25T15:00:00Z",
  read_at: null,
  ...over,
});

describe("DashboardView", () => {
  const boards = [
    makeBoard({ id: "b1", name: "Ideas del sprint" }),
    makeBoard({ id: "b2", name: "Retro del equipo", my_role: "editor", owner_id: "beto" }),
  ];

  it("renderiza en el servidor los nombres reales de los tableros (SSR)", () => {
    const html = renderToString(
      <Providers>
        <DashboardView initialBoards={boards} initialInbox={{ items: [], unread_count: 0 }} />
      </Providers>,
    );
    expect(html).toContain("Ideas del sprint");
    expect(html).toContain("Retro del equipo");
    // React separa nodos de texto con <!-- -->: se quitan para leer el texto visible.
    expect(html.replace(/<!-- -->/g, "")).toContain("Hola, Ana Gómez");
  });

  it("filtra por propiedad y busca por nombre", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DashboardView initialBoards={boards} />);
    await user.click(screen.getByRole("tab", { name: "Compartidos conmigo" }));
    expect(screen.queryByText("Ideas del sprint")).not.toBeInTheDocument();
    expect(screen.getByText("Retro del equipo")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Todos" }));
    await user.type(screen.getByRole("searchbox", { name: "Buscar tableros" }), "retro");
    expect(screen.queryByText("Ideas del sprint")).not.toBeInTheDocument();
  });

  it("crea un tablero por la API y navega a él", async () => {
    const user = userEvent.setup();
    const navigation = fakeNavigation();
    const { transport, calls } = fakeTransport({
      "POST /api/boards": () => ({ status: 201, body: makeBoard({ id: "nuevo", name: "Plan Q4" }) }),
    });
    renderWithProviders(<DashboardView initialBoards={[]} />, { transport, navigation });
    await user.click(screen.getByRole("button", { name: "Crear mi primer tablero" }));
    await user.type(screen.getByRole("textbox", { name: "Nombre" }), "Plan Q4");
    await user.click(screen.getByRole("button", { name: "Crear tablero" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/boards/nuevo"));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/api/boards", body: { name: "Plan Q4" } });
  });
});

describe("NotificationBell", () => {
  it("muestra el contador renderizado en el servidor y abre la bandeja", async () => {
    const user = userEvent.setup();
    const { transport } = fakeTransport({
      "GET /api/notifications": () => ({ body: { items: [notification("n1")], unread_count: 1 } }),
    });
    renderWithProviders(<NotificationBell initial={{ items: [notification("n1")], unread_count: 1 }} />, { transport });
    expect(screen.getByTestId("inbox-unread")).toHaveTextContent("1");
    await user.click(screen.getByRole("button", { name: /Notificaciones, 1 sin leer/ }));
    expect(screen.getByRole("region", { name: "Bandeja de notificaciones" })).toBeInTheDocument();
    expect(screen.getByText("Beto se unió a Ideas del sprint")).toBeInTheDocument();
  });

  it("al abrir una notificación la marca como leída y lleva al tablero", async () => {
    const user = userEvent.setup();
    const navigation = fakeNavigation();
    const markRead = vi.fn(() => ({ body: notification("n1", { read_at: "2026-10-25T16:00:00Z" }) }));
    const { transport } = fakeTransport({
      "GET /api/notifications": () => ({ body: { items: [notification("n1")], unread_count: 1 } }),
      "PATCH /api/notifications/n1/read": markRead,
    });
    renderWithProviders(<NotificationBell initial={{ items: [notification("n1")], unread_count: 1 }} />, {
      transport,
      navigation,
    });
    await user.click(screen.getByRole("button", { name: /Notificaciones/ }));
    await user.click(screen.getByRole("button", { name: /Beto se unió/ }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/boards/b1"));
    expect(markRead).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("inbox-unread")).not.toBeInTheDocument();
  });

  it("si la bandeja no responde lo dice sin romper la página", async () => {
    const user = userEvent.setup();
    const { transport } = fakeTransport({ "GET /api/notifications": () => ({ status: 0 }) });
    renderWithProviders(<NotificationBell />, { transport });
    await user.click(screen.getByRole("button", { name: "Notificaciones" }));
    expect(await screen.findByText(/no está disponible/)).toBeInTheDocument();
  });
});

describe("ChatPanel", () => {
  const chatRoutes = (extra = {}) =>
    fakeTransport({
      "GET /api/chat/boards/b1/messages": () => ({ body: { items: [], next_cursor: null } }),
      ...extra,
    });

  it("muestra el historial inicial y distingue mis mensajes", () => {
    renderWithProviders(
      <ChatPanel
        boardId="b1"
        open
        onClose={() => {}}
        initialPage={{ items: [message("m1"), message("m2", { sender_id: "ana", sender_name: "Ana" })], next_cursor: null }}
      />,
    );
    const log = screen.getByRole("log");
    expect(within(log).getByText("Mensaje m1")).toBeInTheDocument();
    expect(within(log).getByText("Beto Ruiz")).toBeInTheDocument();
    expect(within(log).getByText("Tú")).toBeInTheDocument();
  });

  it("envía con Enter y confirma el mensaje cuando el servidor responde", async () => {
    const user = userEvent.setup();
    const { transport, calls } = chatRoutes({
      "POST /api/chat/boards/b1/messages": (req: { body: { text: string; client_message_id: string } }) => ({
        status: 201,
        body: message("m9", { ...req.body, sender_id: ANA.id, sender_name: ANA.name }),
      }),
    });
    renderWithProviders(
      <ChatPanel boardId="b1" open onClose={() => {}} initialPage={{ items: [], next_cursor: null }} />,
      { transport },
    );
    await user.type(screen.getByRole("textbox", { name: "Escribe un mensaje" }), "Hola equipo{Enter}");
    expect(await screen.findByText("Hola equipo")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Enviando…")).not.toBeInTheDocument());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ text: "Hola equipo" });
    expect((post?.body as { client_message_id: string }).client_message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("permite reintentar un mensaje que no se pudo enviar", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { transport } = chatRoutes({
      "POST /api/chat/boards/b1/messages": (req: { body: { text: string; client_message_id: string } }) =>
        fail ? { status: 0 } : { status: 201, body: message("m5", { ...req.body, sender_id: ANA.id }) },
    });
    renderWithProviders(
      <ChatPanel boardId="b1" open onClose={() => {}} initialPage={{ items: [], next_cursor: null }} />,
      { transport },
    );
    await user.type(screen.getByRole("textbox", { name: "Escribe un mensaje" }), "¿Hay alguien?{Enter}");
    const retry = await screen.findByRole("button", { name: /Reintentar/ });
    fail = false;
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Reintentar/ })).not.toBeInTheDocument());
    expect(screen.getByText("¿Hay alguien?")).toBeInTheDocument();
  });

  it("cuenta los mensajes ajenos que llegan con el panel cerrado", async () => {
    const onUnreadChange = vi.fn();
    const { transport, lastSocket } = chatRoutes();
    renderWithProviders(
      <ChatPanel
        boardId="b1"
        open={false}
        onClose={() => {}}
        onUnreadChange={onUnreadChange}
        initialPage={{ items: [], next_cursor: null }}
      />,
      { transport },
    );
    act(() => lastSocket().open());
    act(() => lastSocket().receive({ type: "message", message: message("m7", { created_at: new Date(Date.now() + 1000).toISOString() }) }));
    await waitFor(() => expect(onUnreadChange).toHaveBeenLastCalledWith(1));
  });
});

describe("BoardWorkspace", () => {
  const canvas = <div data-testid="canvas" />;

  it("el dueño ve herramientas, renombrar y compartir", () => {
    renderWithProviders(<BoardWorkspace board={makeBoard()} canvas={canvas} initialChat={{ items: [], next_cursor: null }} />);
    expect(screen.getByRole("button", { name: "Ideas del sprint" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Herramientas del tablero" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compartir" })).toBeInTheDocument();
  });

  it("quien solo ve no tiene herramientas de dibujo, pero sí chat", () => {
    renderWithProviders(
      <BoardWorkspace
        board={makeBoard({ my_role: "viewer", owner_id: "beto" })}
        canvas={canvas}
        initialChat={{ items: [], next_cursor: null }}
      />,
    );
    expect(screen.queryByRole("complementary", { name: "Herramientas del tablero" })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/solo lectura/);
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ideas del sprint" })).toBeInTheDocument();
  });

  it("abre el WebSocket de dibujo por el transporte, sin token en la ruta", () => {
    const { transport, sockets } = fakeTransport({
      "GET /api/chat/boards/b1/messages": () => ({ body: { items: [], next_cursor: null } }),
    });
    renderWithProviders(<BoardWorkspace board={makeBoard()} canvas={canvas} initialChat={{ items: [], next_cursor: null }} />, {
      transport,
    });
    const paths = sockets.map((s) => s.path);
    expect(paths).toContain("/ws/boards/b1");
    expect(paths).toContain("/ws/chat/boards/b1");
    expect(paths.join(" ")).not.toMatch(/token/);
  });
});
