/** Logout servidor: POST con cookie cb_refresh solo en /session. */
export function SignOutForm() {
  return (
    <form action="/session/logout" method="post">
      <button type="submit" className="btn btn-small btn-quiet">
        Cerrar sesión
      </button>
    </form>
  );
}
