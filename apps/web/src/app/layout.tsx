import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/lib/providers';

export const metadata: Metadata = { title: 'Burtplace Workforce', description: 'HR, Attendance, Timesheet & Payroll platform' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><link rel="preconnect" href="https://fonts.googleapis.com" /><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet" /></head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
