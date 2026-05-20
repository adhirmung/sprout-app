import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { ChartData } from '../lib/claude';

const PALETTE = [
  '#aa3bff', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899',
];

function fmt(v: unknown): string {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
       : n >= 1_000     ? `${(n / 1_000).toFixed(1)}K`
       : String(n);
}

export function VisualChart({ data }: { data: ChartData }) {
  const margin = { top: 24, right: 24, bottom: 56, left: 56 };

  if (data.chartType === 'pie') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data.items}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="45%"
            outerRadius="50%"
            paddingAngle={2}
            label={({ name, percent }: { name?: string; percent?: number }) =>
              `${name ?? ''} (${((percent ?? 0) * 100).toFixed(0)}%)`}
            labelLine={false}
          >
            {data.items.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip formatter={fmt} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (data.chartType === 'line') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data.items} margin={margin}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 12, fill: 'var(--text)' }}
            label={data.xLabel ? { value: data.xLabel, position: 'insideBottom', offset: -12, fontSize: 12, fill: 'var(--text)' } : undefined}
          />
          <YAxis
            tick={{ fontSize: 12, fill: 'var(--text)' }}
            tickFormatter={fmt}
            label={data.yLabel ? { value: data.yLabel, angle: -90, position: 'insideLeft', offset: 12, fontSize: 12, fill: 'var(--text)' } : undefined}
          />
          <Tooltip formatter={fmt} />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#aa3bff"
            strokeWidth={2.5}
            dot={{ r: 4, fill: '#aa3bff', strokeWidth: 0 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Bar (default)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data.items} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 11, fill: 'var(--text)' }}
          interval={0}
          label={data.xLabel ? { value: data.xLabel, position: 'insideBottom', offset: -14, fontSize: 12, fill: 'var(--text)' } : undefined}
        />
        <YAxis
          tick={{ fontSize: 12, fill: 'var(--text)' }}
          tickFormatter={fmt}
          label={data.yLabel ? { value: data.yLabel, angle: -90, position: 'insideLeft', offset: 12, fontSize: 12, fill: 'var(--text)' } : undefined}
        />
        <Tooltip formatter={fmt} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64} label={{ position: 'top', formatter: fmt, style: { fontSize: 11, fill: 'var(--text)' } }}>
          {data.items.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
