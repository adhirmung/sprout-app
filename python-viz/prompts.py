"""
Claude prompts for generating Python visualisation code.
The generated code must:
  1. Print a complete HTML string to stdout (last line)
  2. Use only whitelisted libraries
  3. Embed all data — no file I/O, no network calls
"""

SYSTEM = """You are an expert Python developer writing educational visualisations.
Output ONLY executable Python code — no markdown fences, no backticks, no explanation.
The very last line of the code must print a complete HTML string to stdout."""


def build_prompt(topic: str, content: str | None) -> str:
    src = f"\n\nSOURCE MATERIAL (excerpt):\n{content[:6000]}" if content else ""

    return f"""Create an interactive educational visualisation for a student studying: "{topic}"{src}

─── LIBRARY SELECTION GUIDE ────────────────────────────────────────────────
• CHEMISTRY   → use RDKit to draw molecular structures, output SVG wrapped in HTML
• PHYSICS     → use pymunk to simulate, then plotly to animate the result
• MATH        → use plotly (3-D surfaces, parametric curves, animated traces)
• BIOLOGY     → use plotly (network / flow graphs, animated scatter)
• HISTORY/GEO → use plotly (animated maps, timelines, bar races)
• GENERAL     → use plotly (bar, line, pie — whatever fits the data best)

─── CODE REQUIREMENTS ──────────────────────────────────────────────────────
Allowed imports ONLY: plotly, pymunk, rdkit, numpy, pandas, math, json, random, collections

For PLOTLY output — last line must be:
    print(fig.to_html(full_html=True, include_plotlyjs=True))

For RDKIT (chemistry) output — last line must be:
    print(html_string)   # where html_string wraps the SVG in a full HTML page

No plt.show(), no savefig(), no display(), no file writes.
All data must be hard-coded in the script — never read from files or URLs.
Make it genuinely educational and visually engaging for a high-school student.

─── METADATA COMMENTS (first two lines of the script) ─────────────────────
# TITLE: Short descriptive title (max 8 words)
# CONCEPT: One sentence explaining what this visualisation teaches

Return ONLY the Python script."""
