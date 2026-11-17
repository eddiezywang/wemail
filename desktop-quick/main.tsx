import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  useRouteError,
} from "react-router";
import App, { ErrorBoundary as AppErrorBoundary } from "~/root";
import { MessageDetailView, WorkbenchShell } from "~/routes/_workbench";

type RouteModule = {
  default: ComponentType;
};

function lazyRoute(load: () => Promise<RouteModule>) {
  return async () => ({ Component: (await load()).default });
}

function DesktopErrorBoundary() {
  return <AppErrorBoundary error={useRouteError()} />;
}

function WorkbenchLayout() {
  return (
    <WorkbenchShell
      list={<Outlet />}
      detail={<MessageDetailView />}
    />
  );
}

const router = createBrowserRouter([
  {
    Component: App,
    ErrorBoundary: DesktopErrorBoundary,
    children: [
      {
        Component: WorkbenchLayout,
        children: [
          { index: true, lazy: lazyRoute(() => import("~/routes/inbox")) },
          {
            path: "folder/:folder",
            lazy: lazyRoute(() => import("~/routes/folder")),
          },
          {
            path: "smart-tags/:id",
            lazy: lazyRoute(() => import("~/routes/smart-tags")),
          },
          {
            path: "message/:id",
            lazy: lazyRoute(() => import("~/routes/message")),
          },
          { path: "snoozed", lazy: lazyRoute(() => import("~/routes/snoozed")) },
          {
            path: "scheduled",
            lazy: lazyRoute(() => import("~/routes/scheduled")),
          },
          {
            path: "local-drafts",
            lazy: lazyRoute(() => import("~/routes/local-drafts")),
          },
          { path: "todos", lazy: lazyRoute(() => import("~/routes/todos")) },
          { path: "actions", lazy: lazyRoute(() => import("~/routes/actions")) },
          {
            path: "automation",
            lazy: lazyRoute(() => import("~/routes/automation")),
          },
          { path: "digests", lazy: lazyRoute(() => import("~/routes/digests")) },
          {
            path: "notifications",
            lazy: lazyRoute(() => import("~/routes/notifications")),
          },
          {
            path: "workspace",
            lazy: lazyRoute(() => import("~/routes/workspace")),
          },
          {
            path: "directory",
            lazy: lazyRoute(() => import("~/routes/directory")),
          },
          {
            path: "settings",
            lazy: lazyRoute(() => import("~/routes/settings")),
          },
        ],
      },
      {
        path: "onboarding",
        lazy: lazyRoute(() => import("~/routes/onboarding")),
      },
      {
        path: "__dev/components",
        lazy: lazyRoute(() => import("~/routes/__dev/components")),
      },
      { path: "*", lazy: lazyRoute(() => import("~/routes/not-found")) },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Desktop quick renderer root element is missing");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
