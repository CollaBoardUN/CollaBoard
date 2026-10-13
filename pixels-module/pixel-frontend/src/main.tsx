/**
 * main.tsx
 * Punto de entrada de la aplicación React con Vite.
 * Monta el componente raíz <App /> en el elemento DOM '#root'.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Montaje seguro en modo estricto de React
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
