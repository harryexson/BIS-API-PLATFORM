import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { PortalAuthProvider } from './auth';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortalAuthProvider>
      <App />
    </PortalAuthProvider>
  </React.StrictMode>
);
