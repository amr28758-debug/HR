'use client';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';

const axis = { fontSize: 11, stroke: 'rgb(var(--muted))' };
const tooltipStyle = { contentStyle: { background: 'rgb(var(--surface))', border: '1px solid rgb(var(--border))', borderRadius: 12, fontSize: 12 } };

export function TrendChart({ data, series }: { data: Record<string, unknown>[]; series: { key: string; label: string; color: string }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ left: -20, right: 8, top: 8 }}>
        <defs>{series.map((s) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.35} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} axisLine={false} tickLine={false} /><YAxis tick={axis} axisLine={false} tickLine={false} />
        <Tooltip {...tooltipStyle} /><Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        {series.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} fill={`url(#g-${s.key})`} strokeWidth={2} />)}
      </AreaChart>
    </ResponsiveContainer>
  );
}
export function BarsChart({ data, xKey, series, height = 220, stacked }: { data: Record<string, unknown>[]; xKey: string; series: { key: string; label: string; color: string }[]; height?: number; stacked?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" vertical={false} />
        <XAxis dataKey={xKey} tick={axis} axisLine={false} tickLine={false} /><YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
        <Tooltip {...tooltipStyle} /><Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[6, 6, 0, 0]} stackId={stacked ? 'a' : undefined} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}
export const COLORS = { brand: 'rgb(var(--brand))', success: 'rgb(var(--success))', warning: 'rgb(var(--warning))', danger: 'rgb(var(--danger))', info: 'rgb(var(--info))', muted: 'rgb(var(--muted))' };
