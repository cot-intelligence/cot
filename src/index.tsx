import React from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { App } from './App';
import { QueryProvider } from './lib/QueryProvider';
import { usePrefs } from './lib/prefs';
import './index.css';
import './forest.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Motion>
      <QueryProvider>
        <App />
      </QueryProvider>
    </Motion>
  </React.StrictMode>,
);

/** Motion follows the OS unless the viewer turned it down in Settings. */
function Motion({ children }: { children: React.ReactNode }) {
  const { motion } = usePrefs();
  return <MotionConfig reducedMotion={motion === 'reduced' ? 'always' : 'user'}>{children}</MotionConfig>;
}
