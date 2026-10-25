import { logoutAction } from "@/app/actions/session";

/** Cerrar sesión: POST a una Server Action que borra la cookie en el servidor. */
export function SignOutForm() {
  return (
    <form action={logoutAction}>
      <button type="submit" className="btn btn-small btn-quiet">
        Cerrar sesión
      </button>
    </form>
  );
}
