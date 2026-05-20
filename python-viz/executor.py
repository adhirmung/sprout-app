"""
Safe subprocess executor for generated Python visualisation code.
- Runs in /tmp with a 45-second hard timeout
- Captures stdout (the HTML string) and stderr (error messages)
- Cleans up temp files on every exit path
"""

import asyncio
import os
import sys
import tempfile


async def run_code(code: str, timeout: int = 45) -> dict:
    """
    Execute `code` in a subprocess and return:
      {"html": "<html>...</html>", "error": None}        on success
      {"html": None,              "error": "message"}    on failure
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, dir="/tmp"
    ) as f:
        f.write(code)
        tmp_path = f.name

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd="/tmp",
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return {"html": None, "error": f"Render timed out after {timeout}s"}

        if proc.returncode != 0:
            err = stderr.decode(errors="replace")[:1200]
            return {"html": None, "error": err}

        html = stdout.decode(errors="replace")
        if not html.strip():
            err = stderr.decode(errors="replace")[:600]
            return {"html": None, "error": f"Script produced no output. stderr: {err}"}

        return {"html": html, "error": None}

    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
