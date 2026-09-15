'use client';
import { FaceAttendance } from '@/components/face/face-attendance';

/**
 * Employee / supervisor mobile face attendance. Public page: the phone is a terminal, not an identity — anyone can open
 * it, but only a face the SERVER identifies (1:N) can produce a punch. A signed-in supervisor automatically gets
 * SUPERVISOR_MOBILE mode (sequential employees on one device).
 */
export default function Page() { return <FaceAttendance mode="EMPLOYEE" />; }
