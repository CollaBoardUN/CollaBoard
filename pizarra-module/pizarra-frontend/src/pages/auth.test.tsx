import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuth } from "../auth/authStore";
import { mockApi, fakeToken } from "../test/utils";
import { LoginPage } from "./LoginPage";
import { RegisterPage } from "./RegisterPage";

beforeEach(() => useAuth.getState().logout());

function renderAuth(route: string) {
  render(<MemoryRouter initialEntries={[route]}><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegisterPage />} />
    <Route path="/join/:token" element={<div>Invitación recuperada</div>} />
    <Route path="/" element={<div>Inicio</div>} />
  </Routes></MemoryRouter>);
}

const session = { access_token: fakeToken({ sub: "uuid-1", name: "Ana", exp: Math.floor(Date.now()/1000)+3600 }), token_type: "bearer", user: { id: "uuid-1", name: "Ana", email: "ana@example.com" } };

describe("autenticación", () => {
  it("inicia sesión y devuelve al usuario a su invitación", async () => {
    const { calls } = mockApi({"POST /auth/login":() => ({body:session})});
    renderAuth("/login?next=%2Fjoin%2Fabc");
    const user=userEvent.setup();
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@example.com");
    await user.type(screen.getByLabelText("Contraseña"), "password-123456");
    await user.click(screen.getByRole("button",{name:"Iniciar sesión"}));
    expect(await screen.findByText("Invitación recuperada")).toBeInTheDocument();
    expect(useAuth.getState().user?.name).toBe("Ana");
    expect(calls[0].body).toEqual({email:"ana@example.com",password:"password-123456"});
  });
  it("registra un usuario y confirma las contraseñas", async () => {
    const { calls }=mockApi({"POST /auth/register":()=>({status:201,body:session})});
    renderAuth("/register");
    const user=userEvent.setup();
    await user.type(screen.getByLabelText("Nombre"),"Ana");
    await user.type(screen.getByLabelText("Correo electrónico"),"ana@example.com");
    await user.type(screen.getByLabelText(/^Contraseña/),"password-123456");
    await user.type(screen.getByLabelText("Confirmar contraseña"),"password-123456");
    await user.click(screen.getByRole("button",{name:"Crear cuenta"}));
    expect(await screen.findByText("Inicio")).toBeInTheDocument();
    expect(calls[0].body).toEqual({name:"Ana",email:"ana@example.com",password:"password-123456",confirm_password:"password-123456"});
  });
  it("no manda la solicitud si las contraseñas son diferentes", async () => {
    const { calls }=mockApi({});renderAuth("/register");const user=userEvent.setup();
    await user.type(screen.getByLabelText("Nombre"),"Ana");
    await user.type(screen.getByLabelText("Correo electrónico"),"ana@example.com");
    await user.type(screen.getByLabelText(/^Contraseña/),"password-123456");
    await user.type(screen.getByLabelText("Confirmar contraseña"),"password-654321");
    await user.click(screen.getByRole("button",{name:"Crear cuenta"}));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no coinciden/i);
    expect(calls).toHaveLength(0);
  });
});
