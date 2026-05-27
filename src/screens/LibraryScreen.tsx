import { useEffect, useMemo, useRef, useState } from 'react';
import mammoth from 'mammoth';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { useToast } from '../components/Toast';
import { Store } from '../lib/store';
import { dbSaveLibrary, uploadPdfToStorage } from '../lib/supabase';
import type { FeedSource, LibraryFile, LibraryItem, LibraryTree } from '../lib/types';

const FILE_COLORS: Record<string, string> = { PDF: 'coral', DOCX: 'sky', MP3: 'plum', JPG: 'gold', PNG: 'gold', TEXT: 'brand', IMAGES: 'gold' };

function seedLibrary(): LibraryTree {
  return {
    'Biology': {
      type: 'folder', created: Date.now() - 86400000 * 4,
      children: {
        'Photosynthesis Notes': { type: 'file', fileType: 'PDF', size: 2.4, created: Date.now() - 86400000 * 2, content: 'Photosynthesis is the process by which plants convert sunlight into chemical energy. It occurs in the chloroplasts and produces glucose and oxygen.' },
        'Cell Structure':       { type: 'file', fileType: 'DOCX', size: 1.1, created: Date.now() - 86400000 * 3 },
        'Chapter 4 lecture':    { type: 'file', fileType: 'MP3',  size: 18.2, created: Date.now() - 86400000 },
      },
    },
    'Spanish': {
      type: 'folder', created: Date.now() - 86400000 * 7,
      children: {
        'Verbs - present tense': { type: 'file', fileType: 'TEXT', size: 0.04, created: Date.now() - 86400000 * 6, content: 'ser, estar, tener, hacer, ir, venir, decir, ver, dar, saber, querer, poder, poner, salir, traer' },
        'Vocab — kitchen':       { type: 'file', fileType: 'PDF',  size: 0.8,  created: Date.now() - 86400000 * 4 },
      },
    },
    'Algorithms.pdf': { type: 'file', fileType: 'PDF', size: 12.4, created: Date.now() - 86400000 * 10 },
  };
}

function calcSize(items: LibraryTree): number {
  let sum = 0;
  for (const k in items) {
    const it = items[k];
    if (it.type === 'file') sum += it.size || 0;
    else sum += calcSize(it.children);
  }
  return sum;
}

// Remove transient blobs before writing to localStorage / Supabase
function stripTransient(tree: LibraryTree): LibraryTree {
  return Object.fromEntries(
    Object.entries(tree).map(([k, v]) => [
      k,
      v.type === 'file'
        ? { ...v, pdfBase64: undefined, images: undefined }
        : { ...v, children: stripTransient(v.children) },
    ]),
  );
}

interface LibraryScreenProps {
  onOpenFile: (src: FeedSource) => void;
  userId?: string;
}

export function LibraryScreen({ onOpenFile, userId }: LibraryScreenProps) {
  const [items, setItems] = useState<LibraryTree>(() => Store.get('library', seedLibrary()));
  const [path, setPath] = useState<string[]>([]);
  const [showFolder, setShowFolder] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [search, setSearch] = useState('');
  const [folderName, setFolderName] = useState('');
  const toast = useToast();

  const didMountRef = useRef(false);
  useEffect(() => {
    // Strip transient blobs before persisting — too large for localStorage/Supabase
    const sanitized = stripTransient(items);
    Store.set('library', sanitized);
    if (userId && didMountRef.current) {
      dbSaveLibrary(userId, sanitized).catch(() => {});
    }
    didMountRef.current = true;
  }, [items, userId]);

  const current = useMemo(() => {
    let c: LibraryTree = items;
    for (const seg of path) {
      const entry = c[seg];
      c = entry?.type === 'folder' ? entry.children : {};
    }
    return c;
  }, [items, path]);

  const storageUsed = useMemo(() => calcSize(items), [items]);
  const storageLimit = 500;

  const setCurrent = (next: LibraryTree) => {
    const updated: LibraryTree = JSON.parse(JSON.stringify(items));
    let cursor: LibraryTree = updated;
    for (const seg of path) {
      const entry = cursor[seg];
      if (entry?.type === 'folder') { cursor = entry.children; }
    }
    Object.keys(cursor).forEach(k => delete cursor[k]);
    Object.assign(cursor, next);
    setItems(updated);
  };

  const createFolder = () => {
    if (!folderName.trim()) return;
    const n = folderName.trim();
    if (current[n]) { toast('That name\'s already taken', 'error'); return; }
    setCurrent({ ...current, [n]: { type: 'folder', children: {}, created: Date.now() } });
    toast('Folder created', 'success');
    setShowFolder(false);
    setFolderName('');
  };

  const uploadItem = ({
    title, file, text, pages, images,
  }: { title: string; file: File | null; text: string; pages?: string; images?: { base64: string; name: string; size: number }[] }) => {
    if (!title.trim()) { toast('Title required', 'error'); return; }
    const t = title.trim();
    if (current[t]) { toast('Name already exists', 'error'); return; }

    // ── Multi-image upload ──────────────────────────────────────
    if (images && images.length > 0) {
      const size = images.reduce((s, img) => s + img.size, 0) / (1024 * 1024);
      const b64s = images.map(img => img.base64);
      setCurrent({
        ...current,
        [t]: { type: 'file', fileType: 'IMAGES', size, created: Date.now(), content: null, images: b64s, imageCount: images.length },
      });
      toast(`${images.length} image${images.length !== 1 ? 's' : ''} added ✓`, 'success');
      setShowUpload(false);
      return;
    }

    if (file) {
      const size     = file.size / (1024 * 1024);
      const fileType = file.name.split('.').pop()?.toUpperCase() ?? 'FILE';
      const isText = file.type === 'text/plain' || fileType === 'TXT';
      const isPDF  = file.type === 'application/pdf' || fileType === 'PDF';

      if (isText) {
        const reader = new FileReader();
        reader.onload = () => {
          const content = typeof reader.result === 'string' ? reader.result : null;
          setCurrent({ ...current, [t]: { type: 'file', fileType, size, created: Date.now(), content } });
          toast('Uploaded ✓', 'success');
          setShowUpload(false);
        };
        reader.readAsText(file);
      } else if (isPDF) {
        const estPages = Math.max(1, Math.round(file.size / 102_400));
        toast('Reading PDF…', 'success');
        file.arrayBuffer().then(async buf => {
          const pdfBase64 = await new Promise<string>(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
            reader.readAsDataURL(new Blob([buf], { type: 'application/pdf' }));
          });

          let storagePath: string | undefined;
          if (userId) {
            storagePath = await uploadPdfToStorage(userId, t, pdfBase64)
              .then(p => p ?? undefined)
              .catch(() => { toast('Cloud save failed — PDF only works this session', 'error'); return undefined; });
          }

          const pagesMeta = pages?.trim() || undefined;
          setCurrent({ ...current, [t]: { type: 'file', fileType, size, created: Date.now(), content: null, pdfBase64, storagePath, pages: pagesMeta } });
          const pageLabel = pagesMeta ? ` (pages ${pagesMeta})` : ` (~${estPages} page${estPages !== 1 ? 's' : ''})`;
          toast(`PDF uploaded ✓${pageLabel}`, 'success');
          setShowUpload(false);
        });
      } else if (fileType === 'DOCX' || fileType === 'DOC') {
        toast('Reading document…', 'success');
        file.arrayBuffer().then(async buf => {
          try {
            const result = await mammoth.extractRawText({ arrayBuffer: buf });
            const content = result.value.trim() || null;
            setCurrent({ ...current, [t]: { type: 'file', fileType, size, created: Date.now(), content } });
            toast('Document uploaded ✓', 'success');
          } catch {
            setCurrent({ ...current, [t]: { type: 'file', fileType, size, created: Date.now(), content: null } });
            toast('Uploaded (text extraction failed — map only)', 'error');
          }
          setShowUpload(false);
        });
      } else {
        const content = text.trim() || null;
        setCurrent({ ...current, [t]: { type: 'file', fileType, size, created: Date.now(), content } });
        toast('Uploaded ✓', 'success');
        setShowUpload(false);
      }
    } else {
      const size    = new Blob([text || '']).size / (1024 * 1024);
      setCurrent({ ...current, [t]: { type: 'file', fileType: 'TEXT', size, created: Date.now(), content: text || null } });
      toast('Uploaded ✓', 'success');
      setShowUpload(false);
    }
  };

  const removeItem = (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    const next = { ...current };
    delete next[name];
    setCurrent(next);
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return current;
    const q = search.toLowerCase();
    return Object.fromEntries(Object.entries(current).filter(([k]) => k.toLowerCase().includes(q)));
  }, [current, search]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '20px 28px 12px', borderBottom: '1px solid var(--line)', background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <div className="label-eyebrow" style={{ marginBottom: 4 }}>Library</div>
            <h1 className="display" style={{ fontSize: 28 }}>
              {path.length === 0 ? 'All your study material' : path[path.length - 1]}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setShowFolder(true)}>
              <Icon name="folder" size={16} /> New folder
            </button>
            <button className="btn btn-primary" onClick={() => setShowUpload(true)}>
              <Icon name="upload" size={16} /> Upload
            </button>
          </div>
        </div>

        {/* Breadcrumb + search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--ink-2)', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 13 }} onClick={() => setPath([])}>📚 Library</button>
          {path.map((seg, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="chevron-right" size={14} stroke="var(--ink-3)" />
              <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 13, fontWeight: i === path.length - 1 ? 700 : 500 }}
                onClick={() => setPath(path.slice(0, i + 1))}>{seg}</button>
            </span>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative', width: 220, maxWidth: '100%' }}>
            <Icon name="search" size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)' }} />
            <input className="input" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 36, padding: '8px 12px 8px 36px', fontSize: 13 }} />
          </div>
        </div>
      </div>

      {/* Storage bar */}
      <div style={{ padding: '12px 28px', background: 'var(--card-soft)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Icon name="bolt" size={16} stroke="var(--brand-2)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-2)', fontWeight: 600, marginBottom: 4 }}>
            <span>Storage</span>
            <span className="mono">{storageUsed.toFixed(1)} / {storageLimit} MB</span>
          </div>
          <div style={{ height: 5, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: 'var(--brand)', width: `${Math.min(100, (storageUsed / storageLimit) * 100)}%`, transition: 'width 0.4s' }} />
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
        {Object.keys(filtered).length === 0 ? (
          <EmptyState
            icon={search ? 'search' : 'folder'}
            title={search ? 'Nothing matches' : 'This folder is empty'}
            body={search ? 'Try a different search.' : 'Create a folder or upload a file to get started.'}
            action={!search && (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button className="btn btn-secondary" onClick={() => setShowFolder(true)}>New folder</button>
                <button className="btn btn-primary" onClick={() => setShowUpload(true)}>Upload</button>
              </div>
            )}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
            {Object.entries(filtered)
              .sort(([, a], [, b]) => (a.type === 'folder' ? -1 : 1) - (b.type === 'folder' ? -1 : 1))
              .map(([name, item]) => (
                <ItemCard key={name} name={name} item={item}
                  onOpen={() => item.type === 'folder' ? setPath([...path, name]) : onOpenFile({ path: [...path, name], item })}
                  onDelete={() => removeItem(name)} />
              ))}
          </div>
        )}
      </div>

      {/* New folder modal */}
      <Modal open={showFolder} onClose={() => { setShowFolder(false); setFolderName(''); }} title="New folder"
        footer={<>
          <button className="btn btn-ghost" onClick={() => { setShowFolder(false); setFolderName(''); }}>Cancel</button>
          <button className="btn btn-primary" onClick={createFolder}>Create</button>
        </>}>
        <input className="input" autoFocus placeholder="e.g., Biology, Chapter 1, Spanish vocab"
          value={folderName} onChange={e => setFolderName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createFolder()} />
      </Modal>

      <UploadModal open={showUpload} onClose={() => setShowUpload(false)} onUpload={uploadItem} location={path} />
    </div>
  );
}

function ItemCard({ name, item, onOpen, onDelete }: { name: string; item: LibraryItem; onOpen: () => void; onDelete: () => void }) {
  const isFolder = item.type === 'folder';
  const c = isFolder ? 'gold' : (FILE_COLORS[(item as LibraryFile).fileType] || 'sky');

  return (
    <div className="card" style={{ padding: 16, cursor: 'pointer', position: 'relative', transition: 'transform 0.15s, box-shadow 0.18s' }}
      onClick={onOpen}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.transform = 'translateY(-2px)';
        el.style.boxShadow = 'var(--shadow-2)';
        const btn = el.querySelector<HTMLElement>('.more-btn');
        if (btn) btn.style.opacity = '1';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = 'var(--shadow-1)';
        const btn = el.querySelector<HTMLElement>('.more-btn');
        if (btn) btn.style.opacity = '0';
      }}>
      <button className="more-btn btn btn-ghost" style={{ position: 'absolute', top: 8, right: 8, padding: 6, borderRadius: '50%', opacity: 0, transition: 'opacity 0.15s' }}
        onClick={e => { e.stopPropagation(); onDelete(); }}>
        <Icon name="trash" size={16} stroke="var(--error)" />
      </button>
      <div style={{ width: 48, height: 48, borderRadius: 12, background: `var(--${c}-soft)`, color: `var(--${c})`, display: 'grid', placeItems: 'center', marginBottom: 12 }}>
        <Icon name={isFolder ? 'folder' : 'file'} size={22} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
        {isFolder
          ? `${Object.keys((item as { children: LibraryTree }).children || {}).length} items`
          : (item as LibraryFile).fileType === 'IMAGES'
          ? `${(item as LibraryFile).imageCount ?? '?'} images · ${(item as LibraryFile).size?.toFixed(1)} MB`
          : `${(item as LibraryFile).fileType} · ${(item as LibraryFile).size?.toFixed(1)} MB`}
      </div>
    </div>
  );
}

interface ImageEntry { base64: string; name: string; size: number; preview: string; }

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onUpload: (data: { title: string; file: File | null; text: string; pages?: string; images?: ImageEntry[] }) => void;
  location: string[];
}

function UploadModal({ open, onClose, onUpload, location }: UploadModalProps) {
  const [mode,   setMode]   = useState<'file' | 'images'>('file');
  const [title,  setTitle]  = useState('');
  const [text,   setText]   = useState('');
  const [file,   setFile]   = useState<File | null>(null);
  const [pages,  setPages]  = useState('');
  const [pageMode, setPageMode] = useState<'all' | 'custom'>('all');
  const [images, setImages] = useState<ImageEntry[]>([]);

  useEffect(() => {
    if (open) { setMode('file'); setTitle(''); setText(''); setFile(null); setPages(''); setPageMode('all'); setImages([]); }
  }, [open]);

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    const entries: ImageEntry[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const base64 = await new Promise<string>(resolve => {
        const r = new FileReader();
        r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
        r.readAsDataURL(f);
      });
      const preview = URL.createObjectURL(f);
      entries.push({ base64, name: f.name, size: f.size, preview });
    }
    setImages(prev => [...prev, ...entries]);
    if (!title && entries[0]) setTitle(entries[0].name.replace(/\.[^.]+$/, ''));
  };

  const removeImage = (i: number) => setImages(prev => prev.filter((_, j) => j !== i));

  const moveImage = (i: number, dir: -1 | 1) => {
    setImages(prev => {
      const arr = [...prev];
      const j = i + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr;
    });
  };

  const canSubmit = mode === 'images' ? images.length > 0 && !!title.trim() : !!title.trim();

  return (
    <Modal open={open} onClose={onClose} title="Add content" width={560}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!canSubmit}
          onClick={() => {
            if (mode === 'images') {
              onUpload({ title, file: null, text: '', images });
            } else {
              onUpload({ title, file, text, pages: pageMode === 'custom' ? pages : undefined });
            }
          }}>
          {mode === 'images' ? `Add ${images.length} image${images.length !== 1 ? 's' : ''}` : 'Upload'}
        </button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 6, background: 'var(--bg-tint)', borderRadius: 12, padding: 4 }}>
          {(['file', 'images'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 13,
                background: mode === m ? 'var(--card)' : 'transparent',
                color: mode === m ? 'var(--ink)' : 'var(--ink-3)',
                boxShadow: mode === m ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.15s',
              }}>
              {m === 'file' ? '📄 File / Text' : '🖼️ Images'}
            </button>
          ))}
        </div>

        {/* Saving to */}
        <Field label="Saving to">
          <div className="chip" style={{ padding: '8px 12px', background: 'var(--bg-tint)' }}>
            📚 {location.length === 0 ? 'Library' : location.join(' / ')}
          </div>
        </Field>

        {/* Title */}
        <Field label="Title">
          <input className="input" autoFocus value={title} onChange={e => setTitle(e.target.value)}
            placeholder="e.g., Chapter 3 — Cell biology" />
        </Field>

        {/* ── File mode ─────────────────────────────────────── */}
        {mode === 'file' && (<>
          <Field label="Upload a file">
            <label style={{
              display: 'block', border: '2px dashed var(--line-2)', borderRadius: 14,
              padding: 22, textAlign: 'center', cursor: 'pointer', background: 'var(--bg-tint)',
              transition: 'border-color 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--brand)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line-2)'; }}>
              <input type="file" style={{ display: 'none' }} accept=".pdf,.doc,.docx,.mp3,.wav,.jpg,.jpeg,.png,.txt"
                onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); if (!title) setTitle(f.name.replace(/\.[^.]+$/, '')); } }} />
              {file ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', textAlign: 'left' }}>
                  <Icon name="file" size={28} stroke="var(--brand)" />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{file.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{(file.size / (1024 * 1024)).toFixed(2)} MB</div>
                  </div>
                </div>
              ) : (
                <>
                  <Icon name="upload" size={28} stroke="var(--brand)" />
                  <div style={{ fontWeight: 700, fontSize: 14, marginTop: 6 }}>Click or drop a file</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>PDF, DOCX, MP3, JPG, PNG · max 50 MB</div>
                </>
              )}
            </label>
          </Field>

          {/* PDF page range picker — only shown after a PDF is selected */}
          {file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) && (
            <Field label="Page range">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  {(['all', 'custom'] as const).map(pm => (
                    <label key={pm} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      <input type="radio" name="pageMode" checked={pageMode === pm} onChange={() => setPageMode(pm)}
                        style={{ accentColor: 'var(--brand)' }} />
                      {pm === 'all' ? 'All pages' : 'Custom range'}
                    </label>
                  ))}
                </div>
                {pageMode === 'custom' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <input className="input" value={pages} onChange={e => setPages(e.target.value)}
                      placeholder='e.g. "1-15" or "3, 7-12, 20"'
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} />
                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                      Sprout will focus only on the pages you specify.
                    </div>
                  </div>
                )}
              </div>
            </Field>
          )}

          <div className="divider">or paste text</div>
          <Field label="Notes / text">
            <textarea className="input" value={text} onChange={e => setText(e.target.value)}
              placeholder="Paste your study notes…" style={{ minHeight: 110, resize: 'vertical' }} />
          </Field>
        </>)}

        {/* ── Images mode ───────────────────────────────────── */}
        {mode === 'images' && (<>
          <Field label="Add photos or scans">
            <label style={{
              display: 'block', border: '2px dashed var(--line-2)', borderRadius: 14,
              padding: 22, textAlign: 'center', cursor: 'pointer', background: 'var(--bg-tint)',
              transition: 'border-color 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--brand)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line-2)'; }}>
              <input type="file" multiple accept="image/*" style={{ display: 'none' }}
                onChange={e => addImages(e.target.files)} />
              <Icon name="upload" size={28} stroke="var(--brand)" />
              <div style={{ fontWeight: 700, fontSize: 14, marginTop: 6 }}>Click or drop images</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                JPG, PNG, WEBP, HEIC — select multiple pages at once
              </div>
            </label>
          </Field>

          {images.length > 0 && (
            <Field label={`${images.length} image${images.length !== 1 ? 's' : ''} — drag to reorder`}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 8 }}>
                {images.map((img, i) => (
                  <div key={i} style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1.5px solid var(--line)', background: 'var(--bg-tint)' }}>
                    <img src={img.preview} alt={img.name}
                      style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                    {/* Page number badge */}
                    <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 6, fontSize: 10, fontWeight: 700, padding: '2px 5px' }}>
                      {i + 1}
                    </div>
                    {/* Controls */}
                    <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {i > 0 && (
                        <button onClick={() => moveImage(i, -1)}
                          style={{ background: 'rgba(0,0,0,0.55)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 10, padding: '2px 4px', lineHeight: 1 }}>▲</button>
                      )}
                      {i < images.length - 1 && (
                        <button onClick={() => moveImage(i, 1)}
                          style={{ background: 'rgba(0,0,0,0.55)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 10, padding: '2px 4px', lineHeight: 1 }}>▼</button>
                      )}
                      <button onClick={() => removeImage(i)}
                        style={{ background: 'rgba(200,0,0,0.75)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontSize: 10, padding: '2px 4px', lineHeight: 1 }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </Field>
          )}

          <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '4px 0', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 14 }}>ℹ️</span>
            <span>Images are available for this session only. Re-upload next time to regenerate content.</span>
          </div>
        </>)}
      </div>
    </Modal>
  );
}
