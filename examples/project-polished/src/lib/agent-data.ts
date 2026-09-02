// ============================================================================
// Project Polished — Simulated Repo & UX Issue Datasets
// These mimic what a real Solari + vision-model run would discover.
// ============================================================================

import type { UxIssue } from './agent-types';

export interface RepoProfile {
  url: string;
  owner: string;
  name: string;
  framework: string;
  pages: string[];
  componentCount: number;
  stars: number;
  description: string;
}

// A few realistic demo repos the agent can "operate on"
export const DEMO_REPOS: RepoProfile[] = [
  {
    url: 'https://github.com/acme-corp/landing-page',
    owner: 'acme-corp',
    name: 'landing-page',
    framework: 'Next.js 14 + Tailwind',
    pages: ['/', '/pricing', '/features', '/blog'],
    componentCount: 23,
    stars: 184,
    description: 'Marketing site for ACME — a developer-tooling startup.',
  },
  {
    url: 'https://github.com/indie-hacker/saas-starter',
    owner: 'indie-hacker',
    name: 'saas-starter',
    framework: 'Next.js + shadcn/ui',
    pages: ['/', '/dashboard', '/pricing', '/login'],
    componentCount: 47,
    stars: 1240,
    description: 'Open-source SaaS boilerplate with auth + billing.',
  },
  {
    url: 'https://github.com/open-source-org/docs-site',
    owner: 'open-source-org',
    name: 'docs-site',
    framework: 'Astro + MDX',
    pages: ['/', '/docs', '/docs/quickstart', '/community'],
    componentCount: 18,
    stars: 8732,
    description: 'Documentation portal for a popular open-source library.',
  },
];

export function matchRepo(url: string): RepoProfile {
  const normalized = url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
  const found = DEMO_REPOS.find((r) => normalized.endsWith(r.url.replace('https://', '')));
  if (found) return found;
  // Synthesize a profile for arbitrary URLs
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)/);
  const owner = match?.[1] ?? 'your-org';
  const name = match?.[2] ?? 'your-repo';
  return {
    url: normalized.startsWith('http') ? normalized : `https://github.com/${owner}/${name}`,
    owner,
    name,
    framework: 'Next.js 14 + Tailwind',
    pages: ['/', '/pricing', '/features'],
    componentCount: 31,
    stars: 412,
    description: `Autonomous UI/UX analysis target: ${owner}/${name}.`,
  };
}

// Realistic UX issues a vision model would flag on a typical marketing site.
// Coordinates are percentages of the viewport (0-100) for the simulated screenshot.
export const SAMPLE_ISSUES: UxIssue[] = [
  {
    id: 'issue-1',
    title: 'Primary CTA button overlaps hero image',
    severity: 'high',
    category: 'layout',
    description:
      'The "Get Started Free" button sits on top of the hero illustration at viewport widths between 1024px and 1280px, reducing tap target clarity and visual hierarchy.',
    filePath: 'components/Hero.tsx',
    lineNumber: 42,
    bbox: { x: 38, y: 52, w: 22, h: 8 },
    suggestedFix:
      'Add z-10 to the CTA container and increase bottom padding on the hero text block to prevent overlap on lg breakpoints.',
    status: 'detected',
  },
  {
    id: 'issue-2',
    title: 'Footer links fail WCAG AA contrast ratio',
    severity: 'critical',
    category: 'contrast',
    description:
      'Footer links use text-gray-400 (#9CA3AF) on a white background. Contrast ratio is 2.85:1, below the WCAG AA minimum of 4.5:1 for normal text.',
    filePath: 'components/Footer.tsx',
    lineNumber: 18,
    bbox: { x: 4, y: 88, w: 92, h: 6 },
    suggestedFix:
      'Bump link color from text-gray-400 to text-gray-600 (#4B5563, ratio 7.4:1). Apply hover:text-gray-900 for state feedback.',
    status: 'detected',
  },
  {
    id: 'issue-3',
    title: 'Pricing cards missing hover / focus affordance',
    severity: 'medium',
    category: 'interaction',
    description:
      'The three pricing cards on /pricing have no hover elevation or focus ring, making it ambiguous that they are interactive. Keyboard users cannot tell which card is focused.',
    filePath: 'components/PricingCard.tsx',
    lineNumber: 27,
    bbox: { x: 8, y: 32, w: 84, h: 38 },
    suggestedFix:
      'Add transition-shadow hover:shadow-xl focus-visible:ring-2 focus-visible:ring-emerald-500 to the card root, and a 200ms ease-out transition.',
    status: 'detected',
  },
  {
    id: 'issue-4',
    title: 'Hero headline truncates on mobile breakpoint',
    severity: 'high',
    category: 'responsive',
    description:
      'The H1 uses text-6xl across all breakpoints. On viewports under 640px the headline wraps to 5 lines and clips the descender of "g" characters. Lighthouse mobile score: 71.',
    filePath: 'components/Hero.tsx',
    lineNumber: 31,
    bbox: { x: 6, y: 18, w: 88, h: 14 },
    suggestedFix:
      'Adopt responsive typography: text-4xl sm:text-5xl md:text-6xl. Removes vertical overflow and improves readability on small screens.',
    status: 'detected',
  },
  {
    id: 'issue-5',
    title: 'Form input lacks accessible label association',
    severity: 'medium',
    category: 'a11y',
    description:
      'The email capture input on the homepage uses placeholder text as the only label. Screen readers report an unlabeled field, and placeholder disappears on focus.',
    filePath: 'components/NewsletterForm.tsx',
    lineNumber: 12,
    bbox: { x: 28, y: 76, w: 44, h: 7 },
    suggestedFix:
      'Add an aria-label="Email address" prop and a visually-hidden <label> bound via htmlFor. Keep placeholder as a secondary hint.',
    status: 'detected',
  },
];

// Realistic code diffs the agent would apply.
// Each diff corresponds to one of the SAMPLE_ISSUES above.
export interface DiffSpec {
  issueId: string;
  filePath: string;
  language: string;
  before: string;
  after: string;
}

export const SAMPLE_DIFFS: DiffSpec[] = [
  {
    issueId: 'issue-1',
    filePath: 'components/Hero.tsx',
    language: 'tsx',
    before: `<div className="relative">
  <HeroIllustration className="w-full" />
  <div className="absolute inset-0 flex items-center justify-center">
    <Button>Get Started Free</Button>
  </div>
</div>`,
    after: `<div className="relative">
  <HeroIllustration className="w-full" />
  <div className="absolute inset-0 z-10 flex items-center justify-center pb-6">
    <Button>Get Started Free</Button>
  </div>
</div>`,
  },
  {
    issueId: 'issue-2',
    filePath: 'components/Footer.tsx',
    language: 'tsx',
    before: `<footer className="bg-white">
  <nav className="flex gap-6 text-gray-400">
    <a href="/about">About</a>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </nav>
</footer>`,
    after: `<footer className="bg-white">
  <nav className="flex gap-6 text-gray-600">
    <a href="/about" className="hover:text-gray-900 transition-colors">About</a>
    <a href="/privacy" className="hover:text-gray-900 transition-colors">Privacy</a>
    <a href="/terms" className="hover:text-gray-900 transition-colors">Terms</a>
  </nav>
</footer>`,
  },
  {
    issueId: 'issue-3',
    filePath: 'components/PricingCard.tsx',
    language: 'tsx',
    before: `<div className="rounded-2xl border p-6">
  <h3 className="text-xl font-semibold">{plan.name}</h3>
  <p className="mt-2 text-3xl font-bold">{plan.price}</p>
  <Button className="mt-6 w-full">Choose {plan.name}</Button>
</div>`,
    after: `<div
  tabIndex={0}
  className="rounded-2xl border p-6 transition-all duration-200
             hover:shadow-xl hover:-translate-y-0.5
             focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-emerald-500"
>
  <h3 className="text-xl font-semibold">{plan.name}</h3>
  <p className="mt-2 text-3xl font-bold">{plan.price}</p>
  <Button className="mt-6 w-full">Choose {plan.name}</Button>
</div>`,
  },
  {
    issueId: 'issue-4',
    filePath: 'components/Hero.tsx',
    language: 'tsx',
    before: `<h1 className="text-6xl font-bold tracking-tight">
  Build faster. Ship smarter.
</h1>`,
    after: `<h1 className="text-4xl font-bold tracking-tight
           sm:text-5xl md:text-6xl">
  Build faster. Ship smarter.
</h1>`,
  },
  {
    issueId: 'issue-5',
    filePath: 'components/NewsletterForm.tsx',
    language: 'tsx',
    before: `<input
  type="email"
  placeholder="Enter your email"
  className="rounded-lg border px-4 py-2"
/>`,
    after: `<label htmlFor="email" className="sr-only">Email address</label>
<input
  id="email"
  type="email"
  aria-label="Email address"
  placeholder="Enter your email"
  className="rounded-lg border px-4 py-2"
/>`,
  },
];
