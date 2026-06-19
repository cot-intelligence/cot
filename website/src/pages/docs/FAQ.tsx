import React from 'react';
import { DocsLayout } from '../../components/docs/DocsLayout';
import { DocsHero } from '../../components/docs/DocsHero';
import { FaqList } from '../../components/docs/FaqList';
import { faq } from '../../docs/content';

export function FAQ() {
  return (
    <DocsLayout hero={<DocsHero label={faq.label} heading={faq.heading} />}>
      <FaqList items={faq.items} />
    </DocsLayout>
  );
}
