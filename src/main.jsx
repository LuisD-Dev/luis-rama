import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './styles/premium.css';
import './styles/components.css';
import './styles/landing.css';
import { initScrollEffects } from './scrollEffects.js';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Initialize scroll-based visual effects (reveal, parallax, header blur)
initScrollEffects();
