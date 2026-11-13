// Must be the first import.
import './polyfills.ts';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { errorMessage } from './api/client.ts';
import { AuthProvider } from './auth/AuthContext.tsx';
import { loadConfig } from './config.ts';
import { Toaster } from './design-system/Toast.tsx';
import { showErrorToast } from './design-system/toastStore.ts';
import './index.css';

// Every failed request reports as a toast from here, so pages don't render their own error text.
const reportError = (error: unknown) => showErrorToast(errorMessage(error));
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportError }),
  mutationCache: new MutationCache({ onError: reportError }),
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element not found.');
}

const root = createRoot(rootElement);

// The API and Cognito IDs must be known before anything (AuthProvider's session check first)
// talks to them.
loadConfig().then(
  () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
            <Toaster />
          </BrowserRouter>
        </QueryClientProvider>
      </StrictMode>,
    ),
  (err: unknown) => {
    console.error(err);
    root.render(<p role="alert">VerifCare couldn't start. Please reload the page.</p>);
  },
);
