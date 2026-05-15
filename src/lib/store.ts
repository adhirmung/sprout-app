export const Store = {
  get<T>(key: string, def: T): T {
    try {
      const v = localStorage.getItem('sprout:' + key);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(key: string, val: unknown) {
    try { localStorage.setItem('sprout:' + key, JSON.stringify(val)); } catch {}
  },
  del(key: string) {
    try { localStorage.removeItem('sprout:' + key); } catch {}
  },
};

export function celebrate() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5000;';
  const colors = ['#2F9E5E', '#FF7A5C', '#F4B740', '#4FB7F5', '#8C5BD9'];
  for (let i = 0; i < 24; i++) {
    const dot = document.createElement('div');
    const c = colors[i % colors.length];
    dot.style.cssText = `position:absolute;top:50%;left:50%;width:10px;height:10px;border-radius:2px;background:${c};transform:translate(-50%,-50%);`;
    const angle = (i / 24) * Math.PI * 2;
    const dist = 180 + Math.random() * 120;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;
    dot.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: '1' },
        { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0)`, opacity: '0' },
      ],
      { duration: 900 + Math.random() * 400, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' }
    );
    el.appendChild(dot);
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}
