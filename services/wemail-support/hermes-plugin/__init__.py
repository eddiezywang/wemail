"""Hermes plugin for the WeMail support control and service planes."""

from __future__ import annotations

from .runtime import TOOL_SPECS, build_pre_llm_context


def register(ctx) -> None:
    for spec in TOOL_SPECS:
        ctx.register_tool(
            name=spec["name"],
            toolset="wemail_support",
            schema=spec["schema"],
            handler=spec["handler"],
            description=spec["description"],
            emoji=spec.get("emoji", "📨"),
        )
    ctx.register_hook(
        "pre_llm_call",
        lambda **kwargs: build_pre_llm_context(
            str(kwargs.get("user_message") or ""),
            str(kwargs.get("platform") or ""),
        ),
    )

