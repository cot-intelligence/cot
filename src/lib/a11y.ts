import type React from 'react';

export function activateOnKey(e: React.KeyboardEvent, run: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    run();
  }
}
