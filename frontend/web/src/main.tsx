// Must be the first import.
import './polyfills.ts';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import { loadConfig } from './config.ts';
import './index.css';

const queryClient = new QueryClient();

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
          </BrowserRouter>
        </QueryClientProvider>
      </StrictMode>,
    ),
  (err: unknown) => {
    console.error(err);
    root.render(<p role="alert">Mzazi Care couldn't start. Please reload the page.</p>);
  },
);
