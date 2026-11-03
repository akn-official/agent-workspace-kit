"""Laya as an MCP server: typed, calibrated decisions in one forward pass.

Run: <venv python> laya_mcp.py   (stdio; any MCP client — Claude Code, Codex, Gemini CLI, OpenCode)
"""
import json

import laya
from mcp.server.mcpserver import MCPServer

# ponytail: lazy Router, max_loaded=1. First call ~10-60s (load); language switch reloads.
# Raise max_loaded=2 if you mix English + other languages and have the RAM (~3.5GB).
router = laya.Router()
mcp = MCPServer("laya")

# preset name -> (question builder, the state key its questions refer to)
PRESETS = {
    "guard": (laya.guard_questions, "prompt"),
    "router": (laya.router_questions, "request"),
    "moderation": (laya.moderation_questions, "post"),
    "triage": (laya.triage_questions, "message"),
    "email": (laya.email_questions, "body"),
}


def _slim(result: dict) -> str:
    # Drop raw logits; keep answer, probabilities, confidence, routing.
    for a in result["answers"].values():
        a.pop("action", None)
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def laya_preset(preset: str, text: str) -> str:
    """Run a built-in Laya decision preset on text. ~35ms GPU / ~300ms CPU once loaded.

    preset: guard (jailbreak/prompt-injection/sensitive-data/harm), router (difficulty/domain/
    needs_tools), moderation (toxic/harassment/threat/spam), triage (support-ticket intent/
    urgency/churn), email (category/spam/phishing/urgency).
    Outputs: noul = P(true) 0..1, score = expected level, choice = top label, plus confidence.
    """
    if preset not in PRESETS:
        return f"unknown preset {preset!r}; use one of {sorted(PRESETS)}"
    build, key = PRESETS[preset]
    return _slim(router.predict({key: text}, build()))


@mcp.tool()
def laya_decide(state: dict | str, questions: dict, model: str | None = None) -> str:
    """Answer custom typed questions about a state (text or JSON) in one forward pass.

    questions: {id: {"type": "choice"|"score"|"noul", "instructions": "...", "criteria": ...}}
      choice: criteria = {"label": "description", ...}   (keep under ~20 options)
      score:  criteria = ["level0", "level1", ...]         (ordinal rubric)
      noul:   no criteria; returns P(true)
    model: optional override "english" | "multilingual" | "typed-decisions"; default auto-routes by language.
    Base checkpoints are weak zero-shot on niche tasks; treat confidence < 0.85 as "ask a human".
    """
    return _slim(router.predict(state, questions, model=model))


if __name__ == "__main__":
    mcp.run()
