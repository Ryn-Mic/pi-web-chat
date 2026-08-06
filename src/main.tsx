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

/** 새 대화 초안 — 첫 메시지 전송 시 서버 session_bound 로 /s/$sessionId 교체 */
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

/** 인증 게이트: 세션 토큰 검증 후 앱 진입 (미인증 시 로그인 화면) */
function AuthGate() {
  const status = useAuthStatus();

  useEffect(() => {
    if (status !== "checking") return;
    void checkAuth();
    // 서버 기동 전이라면 3초 간격 재시도
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
