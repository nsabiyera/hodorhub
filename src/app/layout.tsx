import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { getSession } from '@/lib/auth';
import { SignOutButton } from '@/app/_components/sign-out-button';

export const metadata: Metadata = {
  title: 'HodorHub — support decides what gets built',
  description:
    'Charities post the help they need, the public backs it, and companies deliver it with donated employee time. Projects rise by public support, never paid placement.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;900&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <nav className="nav">
          <div className="nav-inner">
            <a className="wordmark" href="/">
              Hodor<span>Hub</span>
            </a>
            <div className="nav-links">
              <a href="/">Browse</a>
              <a href="/?sort=trending">Trending</a>
              {session ? (
                <>
                  <a href="/notifications">Messages</a>
                  <SignOutButton />
                </>
              ) : (
                <a href="/signin">Sign in</a>
              )}
            </div>
          </div>
        </nav>
        {children}
        <footer>
          <div className="wrap">
            HodorHub — charities post the help they need · the public backs it · companies build it
            with donated time.
          </div>
        </footer>
      </body>
    </html>
  );
}
