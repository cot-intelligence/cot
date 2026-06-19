import React from 'react';
import { Nav } from '../components/Nav';
import { Hero } from '../components/Hero';
import { Pillars } from '../components/Pillars';
import { Depth } from '../components/Depth';
import { Capabilities } from '../components/Capabilities';
import { Install } from '../components/Install';
import { CtaBand } from '../components/CtaBand';
import { SiteFooter } from '../components/SiteFooter';

export function Landing() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Pillars />
        <Depth />
        <Capabilities />
        <Install />
        <CtaBand />
      </main>
      <SiteFooter />
    </>
  );
}
