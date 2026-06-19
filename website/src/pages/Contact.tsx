import React, { useState } from 'react';
import { PageLayout } from '../components/PageLayout';
import { DocsHero } from '../components/docs/DocsHero';
import { TurnstileWidget } from '../components/TurnstileWidget';
import { FadeIn } from '../components/ui/FadeIn';
import { contact } from '../content';

type FormState = 'idle' | 'submitting' | 'success' | 'error';

export function Contact() {
  const [type, setType] = useState(contact.types[0].value);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<FormState>('idle');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      setError('Message is required.');
      return;
    }
    if (!token) {
      setError('Complete the captcha first.');
      return;
    }

    setState('submitting');
    setError('');

    try {
      const res = await fetch('/v1/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          email: email.trim() || null,
          message: message.trim(),
          turnstile_token: token,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const messages: Record<string, string> = {
          captcha_failed: 'Captcha verification failed. Try again.',
          captcha_required: 'Complete the captcha first.',
          invalid_message: 'Message must be between 1 and 5000 characters.',
          invalid_email: 'Enter a valid email address.',
          method_not_allowed: 'Contact form is not live yet. Deploy the latest worker.',
        };
        const mapped = data?.error ? messages[data.error] : undefined;
        throw new Error(
          mapped || `Request failed (${res.status}). ${res.status === 405 ? 'The /v1/feedback endpoint needs to be deployed.' : 'Try again.'}`,
        );
      }

      setState('success');
      setMessage('');
      setEmail('');
      setToken(null);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <PageLayout
      cta="docs"
      hero={
        <DocsHero
          label={contact.label}
          heading={contact.heading}
          callout={contact.callout}
        />
      }>
      <FadeIn>
        {state === 'success' ? (
          <div className="border border-ink bg-cream-dark p-8 shadow-soft-md max-w-xl">
            <h2 className="font-serif text-2xl font-bold italic mb-3">{contact.successTitle}</h2>
            <p className="font-mono text-sm text-ink-light leading-relaxed">{contact.successBody}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="max-w-xl space-y-6">
            <div>
              <label
                htmlFor="contact-type"
                className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter block mb-2">
                {contact.fields.type}
              </label>
              <select
                id="contact-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full border-2 border-ink bg-cream px-4 py-3 font-mono text-sm font-bold focus:outline-none focus:border-vermilion">
                {contact.types.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="contact-email"
                className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter block mb-2">
                {contact.fields.email}
              </label>
              <input
                id="contact-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={contact.emailPlaceholder}
                className="w-full border-2 border-ink bg-cream px-4 py-3 font-mono text-sm font-bold placeholder:text-ink-lighter/50 focus:outline-none focus:border-vermilion"
              />
            </div>

            <div>
              <label
                htmlFor="contact-message"
                className="font-mono text-xs font-bold uppercase tracking-widest text-ink-lighter block mb-2">
                {contact.fields.message}
              </label>
              <textarea
                id="contact-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                required
                placeholder={contact.messagePlaceholder}
                className="w-full border-2 border-ink bg-cream px-4 py-3 font-mono text-sm leading-relaxed resize-y min-h-[140px] placeholder:text-ink-lighter/50 focus:outline-none focus:border-vermilion"
              />
            </div>

            <TurnstileWidget onToken={setToken} />

            {error && (
              <p className="font-mono text-xs font-bold uppercase text-vermilion">{error}</p>
            )}

            <button
              type="submit"
              disabled={state === 'submitting'}
              className="px-8 py-3.5 bg-ink text-cream font-mono text-sm font-bold uppercase tracking-widest border-2 border-ink shadow-brutal hover:opacity-90 transition-opacity disabled:opacity-50">
              {state === 'submitting' ? contact.submitting : contact.submit}
            </button>
          </form>
        )}
      </FadeIn>
    </PageLayout>
  );
}
