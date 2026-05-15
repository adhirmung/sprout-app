import React from 'react';

interface IconProps {
  name: string;
  size?: number;
  stroke?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 20, stroke = 'currentColor', style }: IconProps) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke, strokeWidth: 1.8, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, style,
    // Icons are always decorative — the parent button/link provides the accessible name
    'aria-hidden': true as const,
    focusable: 'false' as const,
  };
  switch (name) {
    case 'home': return <svg {...common}><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9.5h4v-6h6v6h4V10"/></svg>;
    case 'library': return <svg {...common}><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="16" rx="1.5"/><path d="M17 5l4 1-3 14-4-1z"/></svg>;
    case 'feed': return <svg {...common}><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/></svg>;
    case 'profile': return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/></svg>;
    case 'user': return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/></svg>;
    case 'search': return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>;
    case 'plus': return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case 'upload': return <svg {...common}><path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 18v2h16v-2"/></svg>;
    case 'folder': return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>;
    case 'file': return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>;
    case 'chevron-right': return <svg {...common}><path d="m9 6 6 6-6 6"/></svg>;
    case 'chevron-left': return <svg {...common}><path d="m15 6-6 6 6 6"/></svg>;
    case 'chevron-down': return <svg {...common}><path d="m6 9 6 6 6-6"/></svg>;
    case 'arrow-right': return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>;
    case 'arrow-left': return <svg {...common}><path d="M19 12H5M11 5l-7 7 7 7"/></svg>;
    case 'check': return <svg {...common}><path d="m5 12 5 5L20 7"/></svg>;
    case 'close': return <svg {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>;
    case 'sparkle': return <svg {...common}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l3 3M15 15l3 3M6 18l3-3M15 9l3-3"/></svg>;
    case 'brain': return <svg {...common}><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 3 3"/><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-3 3"/><path d="M12 4v18"/></svg>;
    case 'flame': return <svg {...common}><path d="M12 3c1 4 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3-1-3 0-5 1-8z"/></svg>;
    case 'trophy': return <svg {...common}><path d="M8 4h8v6a4 4 0 0 1-8 0z"/><path d="M16 5h4v3a3 3 0 0 1-3 3M8 5H4v3a3 3 0 0 0 3 3"/><path d="M10 14h4l-1 4h2v2H9v-2h2z"/></svg>;
    case 'clock': return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
    case 'more': return <svg {...common}><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/></svg>;
    case 'settings': return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>;
    case 'logout': return <svg {...common}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>;
    case 'bolt': return <svg {...common}><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>;
    case 'book': return <svg {...common}><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></svg>;
    case 'play': return <svg {...common}><path d="M7 4v16l13-8z"/></svg>;
    case 'pause': return <svg {...common}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>;
    case 'rotate': return <svg {...common}><path d="M3 12a9 9 0 0 1 15.5-6.3M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3M3 20v-5h5"/></svg>;
    case 'trash': return <svg {...common}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14"/></svg>;
    case 'edit': return <svg {...common}><path d="M12 20h9"/><path d="m16 5 3 3L8 19l-4 1 1-4z"/></svg>;
    case 'eye': return <svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;
    case 'eye-off': return <svg {...common}><path d="M3 3l18 18"/><path d="M10.6 6.1A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.7M6.1 6.1A17 17 0 0 0 2 12s3.5 6 10 6c1.4 0 2.7-.3 3.9-.7"/></svg>;
    case 'menu': return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16"/></svg>;
    case 'lightning': return <svg {...common}><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>;
    default: return null;
  }
}
