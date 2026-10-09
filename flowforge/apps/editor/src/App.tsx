import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  createHashRouter,
  type RouteObject,
} from 'react-router-dom';
import { Toaster } from 'sonner';
import { setUnauthorizedHandler } from './lib/api';
import { useTheme } from './lib/theme';
import { useAuth } from './stores/auth';
import { useNodeTypes } from './stores/nodeTypes';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { AuthPage } from './pages/AuthPage';
import { CredentialsPage } from './pages/CredentialsPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { VariablesPage } from './pages/VariablesPage';
import { WhatsAppPage } from './pages/WhatsAppPage';
import { AgentEditorPage } from './pages/AgentEditorPage';
import { DashboardPage } from './pages/DashboardPage';
import { InvitePage } from './pages/InvitePage';
import { SettingsPage } from './pages/SettingsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { AgentsPage } from './pages/AgentsPage';
import { CallsPage } from './pages/CallsPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { EditorPage } from './pages/editor/EditorPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
});

function AuthGate() {
  const status = useAuth((s) => s.status);
  const loadNodeTypes = useNodeTypes((s) => s.load);
  useEffect(() => {
    if (status === 'authenticated') void loadNodeTypes().catch(() => undefined);
  }, [status, loadNodeTypes]);
  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (status === 'anonymous') return <AuthPage />;
  return <Outlet />;
}

const routes: RouteObject[] = [
  { path: 'invite/:token', element: <InvitePage /> },
  {
    element: <AuthGate />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'templates', element: <TemplatesPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'workflows', element: <WorkflowsPage /> },
          { path: 'executions', element: <ExecutionsPage /> },
          { path: 'credentials', element: <CredentialsPage /> },
          { path: 'variables', element: <VariablesPage /> },
          { path: 'whatsapp', element: <WhatsAppPage /> },
          { path: 'calls', element: <CallsPage /> },
          { path: 'agents', element: <AgentsPage /> },
          { path: 'agents/:id', element: <AgentEditorPage /> },
          { path: 'workflow/:id', element: <EditorPage /> },
          { path: 'workflow/:id/executions', element: <EditorPage /> },
          { path: 'workflow/:id/executions/:executionId', element: <EditorPage /> },
          { path: '*', element: <Navigate to="/workflows" replace /> },
        ],
      },
    ],
  },
];

// Desktop (Tauri) and mobile (Capacitor) builds load from a file/custom scheme, where hash routing is reliable.
// On the web the editor may live under a path (FLOWFORGE_BASE=/app/ on Vercel), so routes start there.
const basename = import.meta.env.BASE_URL.startsWith('/')
  ? import.meta.env.BASE_URL.replace(/\/+$/, '') || '/'
  : '/';
const router =
  import.meta.env.VITE_ROUTER === 'hash'
    ? createHashRouter(routes)
    : createBrowserRouter(routes, { basename });

export function App() {
  const init = useAuth((s) => s.init);
  const dark = useTheme((s) => s.dark);
  useEffect(() => {
    setUnauthorizedHandler(() => useAuth.getState().logout());
    void init();
  }, [init]);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
