import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { BrandProvider } from "./lib/brand";
import { registerServiceWorker } from "./lib/pwa";
import { applyQueryDefaults } from "./lib/query-defaults";
import { ConfirmProvider } from "./components/ui/overlay";
import { router } from "./router";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => count < 2 && !(err && "status" in err && [401, 403, 404].includes((err as { status: number }).status)),
      refetchOnWindowFocus: true,
    },
  },
});

applyQueryDefaults(queryClient);
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
          <Toaster
            position="bottom-left"
            toastOptions={{
              className: "!rounded-ui !border-line !bg-raised !text-fg !shadow-ui-lg !font-sans",
              descriptionClassName: "!text-fg-muted",
            }}
          />
        </ConfirmProvider>
      </BrandProvider>
    </QueryClientProvider>
  </StrictMode>,
);
