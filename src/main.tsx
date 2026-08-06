import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ChatPage } from "./components/ChatPage";
import { LoginPage } from "./components/LoginPage";
import { checkAuth, useAuthStatus } from "./lib/auth";
import { initLocale } from "./lib/i18n";
import { initTheme } from "./lib/theme";
import { initViewportLock } from "./lib/viewport";
import "./styles.css";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

/** Fresh chat draft — the server sends session_bound on the first message and the URL switches to /s/$sessionId */
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatPage,
});

/** Per-session deep link */
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$sessionId",
  component: ChatPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([chatRoute, sessionRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

/** Auth gate: verify the session token before entering the app (login screen when unauthenticated) */
function AuthGate() {
  const status = useAuthStatus();

  useEffect(() => {
    if (status !== "checking") return;
    void checkAuth();
    // Retry every 3s while the server is starting up
    const timer = setInterval(() => void checkAuth(), 3000);
    return () => clearInterval(timer);
  }, [status]);

  if (status === "unauthenticated") return <LoginPage />;
  if (status === "checking") {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <span className="size-2.5 animate-pulse rounded-full bg-amber-400" />
      </div>
    );
  }
  return <RouterProvider router={router} />;
}

initViewportLock();
initTheme();
initLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  </StrictMode>,
);
