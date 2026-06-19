import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { GaPageViews } from './components/GaPageViews';
import { Landing } from './pages/Landing';
import { DocsIndex } from './pages/docs/DocsIndex';
import { StarterGuide } from './pages/docs/StarterGuide';
import { WhyCot } from './pages/docs/WhyCot';
import { FAQ } from './pages/docs/FAQ';
import { Contact } from './pages/Contact';

export function App() {
  return (
    <BrowserRouter>
      <GaPageViews />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/docs" element={<DocsIndex />} />
        <Route path="/docs/starter-guide" element={<StarterGuide />} />
        <Route path="/docs/why-cot" element={<WhyCot />} />
        <Route path="/docs/faq" element={<FAQ />} />
        <Route path="/contact" element={<Contact />} />
      </Routes>
    </BrowserRouter>
  );
}
