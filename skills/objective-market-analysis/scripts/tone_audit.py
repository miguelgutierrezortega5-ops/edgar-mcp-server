#!/usr/bin/env python3
"""Audit a draft answer for softening language and claims without numbers.

Reads the draft from a file argument or stdin. Exit code 1 when it finds
reassurance phrases or probability words with no number in the same sentence,
so the draft can be fixed before it is sent.

  python3 tone_audit.py draft.md
  echo "Probablemente rebote, no te preocupes." | python3 tone_audit.py
"""

import re
import sys

# Reassurance and minimising phrases: they change how a number feels, not what it says.
SOFTENERS = [
    r"\bsolo\b", r"\bsólo\b", r"\bapenas\b", r"\bafortunadamente\b", r"\bpor suerte\b",
    r"no te preocupes", r"\btranquil[oa]s?\b", r"lo bueno es que", r"la buena noticia",
    r"no hay (que|motivo para) alarmarse", r"no es para alarmarse", r"sin pánico",
    r"no pasa nada", r"\bmenos mal\b", r"vale la pena recordar que", r"a largo plazo siempre",
    r"\bjust\b", r"\bonly\b", r"fortunately", r"don't worry", r"the good news",
]
# Words that state a likelihood. They need a number in the same sentence.
VAGUE = [
    r"\bprobable(mente)?\b", r"\bimprobable\b", r"poco probable", r"\bposible(mente)?\b",
    r"\bpodría\b", r"\bsuele\b", r"\bsuelen\b", r"\bla historia favorece\b",
    r"\blikely\b", r"\bunlikely\b", r"\bprobably\b",
]
UP = r"\b(sube|subió|suben|rebote|rebota|recupera|alza|gana|ganancia|alcista|fuerte|sólid[oa])\b"
DOWN = r"\b(cae|cayó|caen|caída|baja|bajó|pérdida|pierde|bajista|riesgo|débil|desplome)\b"


def main():
    text = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
    # Ignore source lists and links.
    body = re.split(r"\n\*\*Fuentes", text)[0]
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n", body) if s.strip()]
    issues = []
    for s in sentences:
        low = s.lower()
        for pat in SOFTENERS:
            if re.search(pat, low):
                issues.append(f"suavizador «{re.search(pat, low).group(0)}»: {s[:120]}")
        for pat in VAGUE:
            if re.search(pat, low) and not re.search(r"\d", s):
                issues.append(f"probabilidad sin número «{re.search(pat, low).group(0)}»: {s[:120]}")
    numeric = sum(1 for s in sentences if re.search(r"\d", s))
    up = len(re.findall(UP, body.lower()))
    down = len(re.findall(DOWN, body.lower()))
    print(f"Frases: {len(sentences)} | con número: {numeric} ({numeric / max(1, len(sentences)):.0%}) | términos al alza: {up} | a la baja: {down}")
    for i in issues:
        print("- " + i)
    if not issues:
        print("Sin suavizadores ni probabilidades sin número.")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
