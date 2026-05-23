import type { DiagramData } from '../lib/gemini';

const NODE_STYLE: Record<string, { bg: string; border: string; color: string }> = {
  start:    { bg: '#ECFDF5', border: '#10B981', color: '#065f46' },
  process:  { bg: '#EFF6FF', border: '#3B82F6', color: '#1e40af' },
  decision: { bg: '#FFF7ED', border: '#F59E0B', color: '#92400e' },
  end:      { bg: '#F5F3FF', border: '#8B5CF6', color: '#4c1d95' },
};
const DEFAULT_NODE = NODE_STYLE.process;

/** BFS to assign each node a depth level */
function buildLevels(data: DiagramData): string[][] {
  const children  = new Map<string, string[]>();
  const inDegree  = new Map<string, number>();
  data.nodes.forEach(n => { children.set(n.id, []); inDegree.set(n.id, 0); });
  data.edges.forEach(e => {
    children.get(e.from)?.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  });

  const depth = new Map<string, number>();
  const queue = data.nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
  queue.forEach(id => depth.set(id, 0));

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const d  = depth.get(id) ?? 0;
    for (const child of (children.get(id) ?? [])) {
      const nd = d + 1;
      if (!depth.has(child) || (depth.get(child) ?? 0) < nd) {
        depth.set(child, nd);
        queue.push(child);
      }
    }
  }
  // Catch any orphaned nodes (cycles, disconnected)
  data.nodes.forEach(n => { if (!depth.has(n.id)) depth.set(n.id, 0); });

  const maxDepth = Math.max(...[...depth.values()]);
  const levels: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  data.nodes.forEach(n => levels[depth.get(n.id) ?? 0].push(n.id));
  return levels;
}

export function VisualDiagram({ data }: { data: DiagramData }) {
  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));
  const levels  = buildLevels(data);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '20px 16px', gap: 0, overflowY: 'auto',
      height: '100%', boxSizing: 'border-box',
    }}>
      {levels.map((ids, li) => (
        <div key={li} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
          {/* Arrow spacer between levels */}
          {li > 0 && (
            <div style={{ fontSize: 22, color: 'var(--border)', padding: '4px 0', lineHeight: 1 }}>↓</div>
          )}

          {/* Row of nodes */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {ids.map(id => {
              const node   = nodeMap.get(id);
              if (!node) return null;
              const style  = NODE_STYLE[node.nodeType ?? 'process'] ?? DEFAULT_NODE;
              return (
                <div
                  key={id}
                  style={{
                    background:   style.bg,
                    border:       `2px solid ${style.border}`,
                    borderRadius: 10,
                    padding:      '10px 18px',
                    fontWeight:   700,
                    fontSize:     13,
                    color:        style.color,
                    textAlign:    'center',
                    minWidth:     90,
                    maxWidth:     180,
                    lineHeight:   1.3,
                  }}
                >
                  {node.label}
                  {node.subtitle && (
                    <div style={{ fontWeight: 400, fontSize: 11, marginTop: 3, opacity: 0.75 }}>
                      {node.subtitle}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
