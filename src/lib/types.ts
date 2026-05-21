export interface User {
  id?: string;    // Supabase auth user id (absent for guests)
  name: string;
  email: string;
  guest?: boolean;
}

/**
 * One cognitive dimension in the learner profile.
 * score is always 0–100 (normalized).
 * Additional fields carry raw psychometric values for
 * downstream personalisation logic.
 */
export interface CognitiveDimension {
  score: number;

  // Working memory
  verbalSpan?: number;   // highest span level ≥ 2/3 correct
  visualSpan?: number;

  // Sustained attention – signal detection theory
  dPrime?: number;       // d′ (sensitivity index)
  hitRate?: number;
  faRate?: number;       // false-alarm rate

  // Executive function – task switching
  switchCost?: number;   // ms (switch RT − repeat RT); lower = better
  efAccuracy?: number;

  // Fluid intelligence + confidence calibration
  accuracy?: number;     // 0–1
  brierScore?: number;   // 0–0.25 well-calibrated; >0.25 miscalibrated
  calibrationBias?: number; // positive = overconfident, negative = under
}

export interface LearnerProfile {
  workingMemory: CognitiveDimension;
  processingSpeed: CognitiveDimension;
  fluidIntelligence: CognitiveDimension;
  executiveFunction: CognitiveDimension;
  sustainedAttention: CognitiveDimension;
  confidence: CognitiveDimension;
  completedAt: number;
}

export interface LibraryFile {
  type: 'file';
  fileType: string;
  size: number;
  created: number;
  content?: string | null;
  pdfBase64?: string;   // transient — present in memory, stripped before Supabase/localStorage
  storagePath?: string; // Supabase Storage path — persisted, used to re-fetch PDF binary
}

export interface LibraryFolder {
  type: 'folder';
  created: number;
  children: LibraryTree;
}

export type LibraryItem = LibraryFile | LibraryFolder;
export type LibraryTree = Record<string, LibraryItem>;

export interface FeedSource {
  path: string[];
  item: LibraryFile;
}

export type Route = 'login' | 'register' | 'assess' | 'home' | 'library' | 'feed' | 'document' | 'profile' | 'progress';
