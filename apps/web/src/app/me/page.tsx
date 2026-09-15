'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/shell';
import { useAuth } from '@/lib/providers';
import { Alert } from '@/components/ui';

/** Employee self-service entry: lands on the caller's own Command Center. */
export default function Page() { return <AppShell><Me /></AppShell>; }
function Me() {
  const { principal } = useAuth();
  const router = useRouter();
  useEffect(() => { if (principal?.employeeId) router.replace(`/employees/${principal.employeeId}`); }, [principal, router]);
  if (principal && !principal.employeeId) return <Alert tone="info">Your login is not linked to an employee record. Ask HR to link your account to your employee number.</Alert>;
  return null;
}
