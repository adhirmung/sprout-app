/**
 * test-map.mjs  —  Two-pass streaming TOC scanner
 *
 * Pass 1 (global, fast): model reads the whole document and returns the
 *   major themes + which named items belong to each theme + activity
 *   sections to exclude. Gives the model global context.
 *
 * Pass 2 (streaming, anchored): model scans sequentially but now knows
 *   the theme hierarchy, so it can correctly demote individual items
 *   (e.g. MERCURY → subtopic of INNER PLANETS) and ignore worksheet
 *   sections (RECORD YOUR FINDINGS, REVISION, etc.).
 *
 * Run:
 *   GEMINI_API_KEY=your_key node test-map.mjs [path/to/file.pdf]
 */

import { readFileSync } from 'fs';
import { GoogleGenAI }  from '@google/genai';

// ── Config ─────────────────────────────────────────────────────
const PDF_PATH = process.argv[2]
  ?? '/Users/adhirmungroo/Downloads/671047988-ENGLISH-HANDBOOK miraya 6.pdf';
const MODEL    = 'gemini-2.5-flash';

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (!API_KEY) {
  console.error('\n❌  Set GEMINI_API_KEY first:  export GEMINI_API_KEY=your_key\n');
  process.exit(1);
}

const client = new GoogleGenAI({ apiKey: API_KEY });

// ── Part helpers ───────────────────────────────────────────────
const pdfPart  = b64  => ({ inlineData: { data: b64, mimeType: 'application/pdf' } });
const textPart = text => ({ text });

// ── JSON extractor ─────────────────────────────────────────────
function extractJson(raw) {
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found:\n' + raw.slice(0, 400));
  return JSON.parse(raw.slice(start, end + 1));
}

// ── TOC line parser ────────────────────────────────────────────
function parseTOCLines(raw) {
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    let prefix = null;
    let rest   = '';

    if      (trimmed.startsWith('SYNTHESIS:')) { prefix = 'synthesis'; rest = trimmed.slice('SYNTHESIS:'.length).trim(); }
    else if (trimmed.startsWith('TOPIC:'))     { prefix = 'topic';     rest = trimmed.slice('TOPIC:'.length).trim(); }
    else if (trimmed.startsWith('SUBTOPIC:'))  { prefix = 'subtopic';  rest = trimmed.slice('SUBTOPIC:'.length).trim(); }

    if (!prefix || !rest) continue;

    const pipe    = rest.indexOf(' | ');
    const title   = pipe >= 0 ? rest.slice(0, pipe).trim() : rest.trim();
    const summary = pipe >= 0 ? rest.slice(pipe + 3).trim() : '';
    if (title) entries.push({ type: prefix, title, summary });
  }
  return entries;
}

// ── ContentMap assembler ───────────────────────────────────────
function assembleTOC(entries) {
  let synthesis = '';
  const topics  = [];
  let topicIdx  = 0;
  const seen    = new Set(); // deduplicate topic titles

  for (const entry of entries) {
    if (entry.type === 'synthesis') {
      synthesis = entry.title + (entry.summary ? ' ' + entry.summary : '');
      continue;
    }

    if (entry.type === 'topic') {
      const key = entry.title.toLowerCase().trim();

      // Deduplicate — same topic heading appearing twice in the doc
      if (seen.has(key)) continue;
      seen.add(key);

      // Elaborating-subtitle guard — same as gemini.ts
      if (topics.length > 0) {
        const prev      = topics[topics.length - 1];
        const prevLow   = prev.title.toLowerCase();
        const curLow    = entry.title.toLowerCase();
        const wordCount = entry.title.trim().split(/\s+/).length;
        if (wordCount >= 6 && curLow.startsWith(prevLow + ' ')) {
          prev.subtopics.push({
            id:      `t${topicIdx}s${prev.subtopics.length + 1}`,
            title:   entry.title,
            summary: entry.summary || `Covers ${entry.title}.`,
          });
          continue;
        }
      }

      topicIdx++;
      topics.push({ id: `t${topicIdx}`, title: entry.title,
        summary: entry.summary || `Covers ${entry.title}.`, subtopics: [] });

    } else if (entry.type === 'subtopic' && topics.length > 0) {
      const parent = topics[topics.length - 1];
      parent.subtopics.push({
        id:      `t${topicIdx}s${parent.subtopics.length + 1}`,
        title:   entry.title,
        summary: entry.summary || `Covers ${entry.title}.`,
      });
    }
  }

  return { synthesis, topics };
}

// ── PASS 1 — Global theme extraction ──────────────────────────
async function extractThemes(pdfBase64) {
  const prompt = `Read this document carefully from start to finish.

Your job is to understand the document's logical hierarchy — not its visual formatting.

Return a JSON object with:
1. "subject"  — the subject/topic name of this document (e.g. "Earth and Beyond", "English Grammar")
2. "themes"   — the 5–12 major content themes/chapters in reading order.
                 For each theme list the specific named items that belong to it as members
                 (e.g. if "Inner Planets" is a theme, its members are Mercury, Venus, Earth, Mars).
                 Leave "members" empty [] if the theme has no named sub-items.
3. "exclude"  — headings that are worksheet activities, not content
                 (e.g. "Record Your Findings", "Discuss the Image", "Revision", "Activity").

Return ONLY valid JSON — no markdown:
{
  "subject": "Document subject",
  "themes": [
    { "title": "Theme Title", "members": ["Named item 1", "Named item 2"] },
    { "title": "Theme with no sub-items", "members": [] }
  ],
  "exclude": ["Worksheet heading", "Activity heading"]
}`;

  console.log('\n⏳  Pass 1 — Global theme extraction…');
  const t0 = Date.now();

  const response = await client.models.generateContent({
    model:    MODEL,
    contents: [{ role: 'user', parts: [pdfPart(pdfBase64), textPart(prompt)] }],
    config:   {
      systemInstruction: 'You are a precise JSON generator. Output only valid JSON — no markdown, no extra text.',
      maxOutputTokens:   3000,
      temperature:       0.0,
      thinkingConfig:    { thinkingBudget: 0 },
    },
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const usage   = response.usageMetadata;
  console.log(`✅  Pass 1 done  ${elapsed}s  (in: ${usage?.promptTokenCount ?? '?'}, out: ${usage?.candidatesTokenCount ?? '?'} tokens)`);

  return extractJson(response.text ?? '');
}

// ── PASS 2 — Anchored streaming scan ──────────────────────────
async function streamAnchored(pdfBase64, subject, themes, exclude) {
  const themeList = themes.map((t, i) => {
    const members = t.members?.length
      ? `  members → ${t.members.join(', ')}`
      : '  (no named sub-items)';
    return `  ${i + 1}. ${t.title}\n${members}`;
  }).join('\n');

  const excludeBlock = exclude?.length
    ? `\nWorksheet/activity sections — emit NOTHING for these headings:\n${exclude.map(e => `  ✗ ${e}`).join('\n')}`
    : '';

  const prompt = `Scan the document "${subject}" from start to finish and build a Table of Contents.

The document has these major themes identified from a global read:
${themeList}
${excludeBlock}

For each piece of text you encounter, classify it and emit ONE of these line types — or emit nothing:

  SYNTHESIS: [two sentences about the whole document]   ← once only, at the very start
  TOPIC: [exact title] | [one sentence summary]         ← when you reach a major theme
  SUBTOPIC: [exact title] | [one sentence summary]      ← when you reach a named member of the current theme

Classification rules:
- TOPIC  → emit when you first encounter each major theme from the list above. One line per theme.
- SUBTOPIC → emit for every named member listed under the current theme.
  Example: theme "Inner Planets" has members Mercury, Venus, Earth, Mars →
    when you see the Mercury heading, emit: SUBTOPIC: Mercury | …
    when you see Venus, emit: SUBTOPIC: Venus | …  etc.
- Worksheet/activity headings (in the exclude list above) → emit NOTHING
- Body text, bullet points, tables, examples → emit NOTHING
- If the same heading appears more than once → emit it only the FIRST time
- Once inside a SUBTOPIC, all nested content is silence — emit NOTHING

Output one line per item, no blank lines, no other text.

Begin scanning from the very first page now:`;

  console.log('\n⏳  Pass 2 — Anchored streaming scan…');
  const t0 = Date.now();

  let accumulated  = '';
  let inputTokens  = 0;
  let outputTokens = 0;
  let chunkCount   = 0;

  process.stdout.write('\n── RAW MODEL OUTPUT (Pass 2) ──────────────────────────\n');

  const stream = await client.models.generateContentStream({
    model:    MODEL,
    contents: [{ role: 'user', parts: [pdfPart(pdfBase64), textPart(prompt)] }],
    config:   {
      systemInstruction: 'Output ONLY SYNTHESIS:, TOPIC:, and SUBTOPIC: lines. No other text.',
      maxOutputTokens:   8000,
      temperature:       0.0,
      thinkingConfig:    { thinkingBudget: 0 },
    },
  });

  for await (const chunk of stream) {
    const t = chunk.text ?? '';
    if (t) {
      accumulated += t;
      process.stdout.write(t);
      chunkCount++;
    }
    if (chunk.usageMetadata) {
      inputTokens  = chunk.usageMetadata.promptTokenCount ?? inputTokens;
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write('\n── END RAW OUTPUT ────────────────────────────────────\n');
  console.log(`\n✅  Pass 2 done  ${elapsed}s | ${chunkCount} chunks | in: ${inputTokens} / out: ${outputTokens} tokens`);

  return accumulated;
}

// ── Print helpers ──────────────────────────────────────────────
function printThemes(subject, themes, exclude) {
  console.log('\n── PASS 1 RESULT ─────────────────────────────────────');
  console.log(`  Subject: ${subject}`);
  console.log(`  Themes (${themes.length}):`);
  for (const [i, t] of themes.entries()) {
    console.log(`    ${i + 1}. ${t.title}`);
    if (t.members?.length) console.log(`       → ${t.members.join(', ')}`);
  }
  if (exclude?.length) {
    console.log(`  Excluded (${exclude.length}): ${exclude.join(', ')}`);
  }
  console.log('──────────────────────────────────────────────────────\n');
}

function printMap(map) {
  const totalSub = map.topics.reduce((n, t) => n + t.subtopics.length, 0);
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  FINAL CONTENT MAP  —  ${map.topics.length} topics, ${totalSub} subtopics`);
  console.log('══════════════════════════════════════════════════════');
  console.log(`\nSYNTHESIS:\n  ${map.synthesis}\n`);
  for (const [i, t] of map.topics.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ● ${t.title}`);
    console.log(`       ${t.summary}`);
    for (const s of t.subtopics) {
      console.log(`         ○ ${s.title}`);
      console.log(`           ${s.summary}`);
    }
  }
  console.log('\n══════════════════════════════════════════════════════\n');
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const totalT0 = Date.now();

  console.log('\n════════════════════════════════════════════════════');
  console.log('  TWO-PASS STREAMING TOC SCANNER — test harness');
  console.log('════════════════════════════════════════════════════');
  console.log(`  PDF   : ${PDF_PATH}`);
  console.log(`  Model : ${MODEL}`);
  console.log('════════════════════════════════════════════════════');

  const pdfBase64 = readFileSync(PDF_PATH).toString('base64');
  console.log(`\nPDF loaded  (${(pdfBase64.length / 1024).toFixed(0)} KB base64)`);

  // Pass 1 — global theme extraction
  const { subject, themes, exclude } = await extractThemes(pdfBase64);
  printThemes(subject, themes, exclude);

  // Pass 2 — anchored streaming scan
  const raw     = await streamAnchored(pdfBase64, subject, themes, exclude);
  const entries = parseTOCLines(raw);
  const map     = assembleTOC(entries);
  printMap(map);

  const totalElapsed = ((Date.now() - totalT0) / 1000).toFixed(1);
  console.log(`Total time: ${totalElapsed}s\n`);
}

main().catch(err => {
  console.error('\n❌  Error:', err.message ?? err);
  process.exit(1);
});
