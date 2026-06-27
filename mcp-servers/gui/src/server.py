"""Stub MCP server for OS-level GUI/desktop control (mouse, keyboard, screen capture).

Deferred: nothing in the current target workflow needs mouse/screen control,
so this registers zero tools. It exists to prove the orchestrator's "spawn N
MCP servers from config" plumbing is language-agnostic -- this is the first
real Python tool server, started the same way as the TS ones, talking the
same protocol. Add tools here (likely via pyautogui/mss) when GUI control is
actually needed.
"""

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("marionet-gui")

if __name__ == "__main__":
    mcp.run(transport="stdio")
