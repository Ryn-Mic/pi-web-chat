import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatPage } from "./components/ChatPage";
import { initLocale } from "./lib/i18n";
import { initTheme } from "./lib/theme";
import { initViewportLock } from "./lib/viewport";
import "./styles.css";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

/** 새 세션 (서버가 세션을 만들면 /s/$sessionId 로 교체된다) */
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatPage,
});

/** 세션별 딥링크 */
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

initViewportLock();
initTheme();
initLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
