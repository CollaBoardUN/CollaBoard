import { Link, Route, Routes } from "react-router-dom";

import { RequireAuth } from "./auth/RequireAuth";
import { Toaster } from "./components/Toaster";
import { BoardPage } from "./pages/BoardPage";
import { DashboardPage } from "./pages/DashboardPage";
import { JoinPage } from "./pages/JoinPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";

function NotFound() {
  return (
    <main className="center-page">
      <div className="panel">
        <h1>Esta página no existe</h1>
        <Link to="/" className="btn btn-primary">
          Ir a mis tableros
        </Link>
      </div>
    </main>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
        <Route path="/boards/:boardId" element={<RequireAuth><BoardPage /></RequireAuth>} />
        <Route path="/join/:token" element={<RequireAuth><JoinPage /></RequireAuth>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster />
    </>
  );
}
